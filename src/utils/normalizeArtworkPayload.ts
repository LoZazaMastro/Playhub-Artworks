import { assertBase64PayloadSize, assertBlobSize, assertImageDimensions, base64ToBlob, blobToSafeDataUrl,
  boundedArtworkSize, canvasToBase64, IMAGE_DECODE_TIMEOUT_MS, loadSafeImage, MAX_ARTWORK_BYTES,
  MAX_ARTWORK_DIMENSION, MAX_ARTWORK_PIXELS, MAX_SOURCE_DIMENSION, MAX_SOURCE_PIXELS,
  releaseCanvas, releaseImage, throwIfImageCancelled, withCompositionLock } from './imageSafety';
import { artworkMime, inspectImageBlob } from './imageMetadata';

export interface ArtworkPayload {
  data: string;
  format: string;
  animated?: boolean;
  dimensions?: [number, number] | null;
  sha256?: string;
  transferToken?: string;
}

/** createImageBitmap can settle after cancellation; close even a late bitmap. */
const decodeBitmap = (blob: Blob, width: number, height: number, signal?: AbortSignal) => new Promise<ImageBitmap>((resolve, reject) => {
  let settled = false;
  const finish = (error?: Error, bitmap?: ImageBitmap) => {
    if (settled) { bitmap?.close(); return; }
    settled = true;
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (error) { bitmap?.close(); reject(error); } else resolve(bitmap!);
  };
  const abort = () => finish(new DOMException('PA_OPERATION_CANCELLED', 'AbortError'));
  const timer = window.setTimeout(() => finish(new Error('PA_ERROR_OPERATION_TIMEOUT')), IMAGE_DECODE_TIMEOUT_MS);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) { abort(); return; }
  try {
    createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
      .then(bitmap => finish(undefined, bitmap), error => finish(error));
  } catch (error) { finish(error as Error); }
});

/** Source budget and final Steam payload budget are deliberately independent. */
export const normalizeArtworkBlob = async (blob: Blob, signal?: AbortSignal): Promise<ArtworkPayload> => {
  assertBlobSize(blob, true);
  throwIfImageCancelled(signal);
  const metadata = await inspectImageBlob(blob);
  const { format, animated, dimensions } = metadata;
  if (dimensions) {
    const [width, height] = dimensions;
    if (width <= 0 || height <= 0 || width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION || width * height > MAX_SOURCE_PIXELS) {
      throw new Error('PA_ERROR_ARTWORK_TOO_LARGE');
    }
  }
  if (animated) {
    // Never silently turn an APNG/GIF/animated WebP/WebM into a still picture.
    if (blob.size > MAX_ARTWORK_BYTES || (dimensions && (dimensions[0] > MAX_ARTWORK_DIMENSION || dimensions[1] > MAX_ARTWORK_DIMENSION || dimensions[0] * dimensions[1] > MAX_ARTWORK_PIXELS))) {
      throw new Error('PA_ERROR_ANIMATED_ARTWORK_TOO_LARGE');
    }
    const data = (await blobToSafeDataUrl(blob)).split(',', 2)[1];
    throwIfImageCancelled(signal);
    return { data, format: 'png', animated: true, dimensions };
  }
  return await withCompositionLock(async () => {
    throwIfImageCancelled(signal);
    let image: HTMLImageElement | null = null;
    let bitmap: ImageBitmap | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let objectUrl = '';
    try {
      if (!dimensions) throw new Error('PA_ERROR_INVALID_ARTWORK');
      const [width, height] = boundedArtworkSize(...dimensions);
      // Preserve already-suitable PNG/JPEG bytes (and quality) unchanged.
      if (blob.size <= MAX_ARTWORK_BYTES && width === dimensions[0] && height === dimensions[1] && (format === 'png' || format === 'jpg')) {
        objectUrl = URL.createObjectURL(blob);
        image = await loadSafeImage(objectUrl, signal);
        assertImageDimensions(image);
        return { data: (await blobToSafeDataUrl(blob)).split(',', 2)[1], format, animated: false, dimensions };
      }
      // Decode into the bounded working resolution where supported by Steam's Chromium.
      if (typeof createImageBitmap === 'function') {
        try { bitmap = await decodeBitmap(blob, width, height, signal); }
        catch (error: any) {
          if (error?.name === 'AbortError' || error?.message === 'PA_ERROR_OPERATION_TIMEOUT') throw error;
          // Older Steam Chromium builds can reject resize options. The guarded Image path still works.
        }
      }
      if (!bitmap) {
        objectUrl = URL.createObjectURL(blob);
        image = await loadSafeImage(objectUrl, signal);
      }
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const outputFormat = format === 'jpg' ? 'jpg' : 'png';
      for (let attempt = 0; attempt < 6; attempt += 1) {
        throwIfImageCancelled(signal);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('PA_ERROR_INVALID_ARTWORK');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap || image!, 0, 0, canvas.width, canvas.height);
        try {
          const data = await canvasToBase64(canvas, outputFormat);
          throwIfImageCancelled(signal);
          return { data, format: outputFormat, animated: false, dimensions: [canvas.width, canvas.height] };
        } catch (error: any) {
          if (error?.message !== 'PA_ERROR_ARTWORK_TOO_LARGE' || attempt === 5) throw error;
          // Try recompression at the same dimensions first, then reduce gradually.
          // PNG/WebP/logos never lose alpha to a JPEG conversion.
          canvas.width = Math.max(1, Math.floor(canvas.width * .85));
          canvas.height = Math.max(1, Math.floor(canvas.height * .85));
        }
      }
      throw new Error('PA_ERROR_ARTWORK_TOO_LARGE');
    } finally {
      bitmap?.close();
      releaseImage(image);
      releaseCanvas(canvas);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  });
};

/** Compatibility entry point for existing, bounded in-memory callers. */
export const normalizeArtworkPayload = async (payload: ArtworkPayload): Promise<{ data: string; format: 'png' | 'jpg' }> => {
  assertBase64PayloadSize(payload.data, true);
  const blob = base64ToBlob(payload.data, artworkMime(payload.format), true);
  const normalized = await normalizeArtworkBlob(blob);
  return { data: normalized.data, format: normalized.format as 'png' | 'jpg' };
};

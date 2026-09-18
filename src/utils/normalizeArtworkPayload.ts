import { assertBase64PayloadSize, assertImageDimensions, boundedArtworkSize, canvasToBase64,
  loadSafeImage, releaseCanvas, releaseImage, withCompositionLock } from './imageSafety';

export interface ArtworkPayload {
  data: string;
  format: string;
  animated?: boolean;
  dimensions?: [number, number] | null;
}

/** Static oversize sources are resized before reaching Steam; animations stay intact. */
export const normalizeArtworkPayload = async (payload: ArtworkPayload): Promise<{ data: string; format: 'png' | 'jpg' }> => {
  assertBase64PayloadSize(payload.data);
  // Steam accepts animated WebM via the established fake-PNG path; Image cannot decode video.
  if (payload.animated && payload.format === 'webm') return { data: payload.data, format: 'png' };
  return await withCompositionLock(async () => {
    const format = payload.format === 'jpeg' ? 'jpg' : payload.format;
    const mime = format === 'ico' ? 'image/x-icon' : format === 'jpg' ? 'image/jpeg' : `image/${format}`;
    let image: HTMLImageElement | null = null;
    let canvas: HTMLCanvasElement | null = null;
    try {
      image = await loadSafeImage(`data:${mime};base64,${payload.data}`);
      const [width, height] = boundedArtworkSize(image.naturalWidth, image.naturalHeight);
      if (payload.animated) {
        // Resizing via canvas would silently remove animation. Reject instead.
        assertImageDimensions(image);
        return { data: payload.data, format: 'png' };
      }
      if (width === image.naturalWidth && height === image.naturalHeight && (format === 'png' || format === 'jpg')) {
        return { data: payload.data, format };
      }
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      // JPEG input remains JPEG; PNG/WebP/logo input keeps transparency.
      const outputFormat = format === 'jpg' ? 'jpg' : 'png';
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('PA_ERROR_INVALID_ARTWORK');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        try {
          return { data: await canvasToBase64(canvas, outputFormat), format: outputFormat };
        } catch (error: any) {
          // A compressed WebP can expand past the byte budget when converted to PNG.
          // Reduce resolution, never discard transparency or relax the RPC byte cap.
          if (error?.message !== 'PA_ERROR_ARTWORK_TOO_LARGE' || attempt === 3) throw error;
          canvas.width = Math.max(1, Math.floor(canvas.width * .75));
          canvas.height = Math.max(1, Math.floor(canvas.height * .75));
        }
      }
      throw new Error('PA_ERROR_ARTWORK_TOO_LARGE');

    } finally {
      releaseImage(image);
      releaseCanvas(canvas);
    }
  });
};

import t from './i18n';
import {
  assertBase64PayloadSize,
  assertBlobSize,
  loadSafeImage,
  releaseCanvas,
  releaseImage,
  withCompositionLock,
} from './imageSafety';
export interface ArtworkPayload {
  data: string;
  format: string;
  animated?: boolean;
}

/**
 * Steam's API only accepts png/jpg as its filename type. Static WebP assets are
 * converted losslessly to PNG; animated assets intentionally use SteamGridDB's
 * established fake-PNG path so their animation remains intact in SteamUI.
 */
export const normalizeArtworkPayload = async (payload: ArtworkPayload): Promise<{ data: string; format: 'png' | 'jpg' }> => {
  assertBase64PayloadSize(payload.data);
  if (payload.format === 'png') return { data: payload.data, format: 'png' };
  if (payload.format === 'jpg') return { data: payload.data, format: 'jpg' };
  if (payload.animated) return { data: payload.data, format: 'png' };

  return await withCompositionLock(async () => {
    const mime = payload.format === 'ico' ? 'image/x-icon' : `image/${payload.format}`;
    const blob = await (await fetch(`data:${mime};base64,${payload.data}`)).blob();
    assertBlobSize(blob);
    const objectUrl = URL.createObjectURL(blob);
    let image: HTMLImageElement | null = null;
    let canvas: HTMLCanvasElement | null = null;
    try {
      image = await loadSafeImage(objectUrl);
      canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context || !canvas.width || !canvas.height) throw new Error(t('PA_ERROR_INVALID_ARTWORK', 'The artwork is invalid.'));
      context.drawImage(image, 0, 0);
      const data = canvas.toDataURL('image/png').split(',', 2)[1] ?? '';
      assertBase64PayloadSize(data);
      return { data, format: 'png' };
    } finally {
      releaseImage(image);
      releaseCanvas(canvas);
      URL.revokeObjectURL(objectUrl);
    }
  });
};

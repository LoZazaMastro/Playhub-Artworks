export interface ArtworkPayload {
  data: string;
  format: string;
  animated?: boolean;
}

const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('Impossibile decodificare l’artwork.'));
  image.src = url;
});

/**
 * Steam's API only accepts png/jpg as its filename type. Static WebP assets are
 * converted losslessly to PNG; animated assets intentionally use SteamGridDB's
 * established fake-PNG path so their animation remains intact in SteamUI.
 */
export const normalizeArtworkPayload = async (payload: ArtworkPayload): Promise<{ data: string; format: 'png' | 'jpg' }> => {
  if (payload.format === 'png') return { data: payload.data, format: 'png' };
  if (payload.format === 'jpg') return { data: payload.data, format: 'jpg' };
  if (payload.animated) return { data: payload.data, format: 'png' };

  const mime = payload.format === 'ico' ? 'image/x-icon' : `image/${payload.format}`;
  const objectUrl = URL.createObjectURL(await (await fetch(`data:${mime};base64,${payload.data}`)).blob());
  try {
    const image = await loadImage(objectUrl);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) throw new Error('Artwork non valido.');
    context.drawImage(image, 0, 0);
    return { data: canvas.toDataURL('image/png').split(',', 2)[1], format: 'png' };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

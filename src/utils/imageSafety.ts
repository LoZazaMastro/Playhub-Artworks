export const MAX_ARTWORK_BYTES = 16 * 1024 * 1024;
export const MAX_ARTWORK_PIXELS = 16_000_000;
export const MAX_ARTWORK_DIMENSION = 6144;
export const IMAGE_FETCH_TIMEOUT_MS = 20_000;
export const IMAGE_DECODE_TIMEOUT_MS = 15_000;

const tooLarge = () => new Error('PA_ERROR_ARTWORK_TOO_LARGE');

export const estimatedBase64Bytes = (payload: string): number => {
  const normalized = String(payload || '').trim();
  if (!normalized) return 0;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
};

export const assertBase64PayloadSize = (payload: string) => {
  if (estimatedBase64Bytes(payload) > MAX_ARTWORK_BYTES) throw tooLarge();
};

export const assertDataUrlSize = (source: string) => {
  if (!source.startsWith('data:')) return;
  const comma = source.indexOf(',');
  if (comma < 0) throw new Error('PA_ERROR_INVALID_ARTWORK');
  assertBase64PayloadSize(source.slice(comma + 1));
};

export const assertBlobSize = (blob: Blob) => {
  if (blob.size > MAX_ARTWORK_BYTES) throw tooLarge();
};

export const assertImageDimensions = (image: HTMLImageElement) => {
  const width = Number(image.naturalWidth || 0);
  const height = Number(image.naturalHeight || 0);
  if (
    width <= 0
    || height <= 0
    || width > MAX_ARTWORK_DIMENSION
    || height > MAX_ARTWORK_DIMENSION
    || width * height > MAX_ARTWORK_PIXELS
  ) {
    throw tooLarge();
  }
};

export const loadSafeImage = (source: string, signal?: AbortSignal) => new Promise<HTMLImageElement>((resolve, reject) => {
  try {
    assertDataUrlSize(source);
  } catch (error) {
    reject(error);
    return;
  }
  const image = new Image();
  let settled = false;
  const cleanup = () => {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    image.onload = null;
    image.onerror = null;
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    image.src = '';
    reject(error);
  };
  const onAbort = () => fail(new Error('PA_OPERATION_CANCELLED'));
  const timer = window.setTimeout(
    () => fail(new Error('PA_ERROR_OPERATION_TIMEOUT')),
    IMAGE_DECODE_TIMEOUT_MS
  );
  image.onload = () => {
    if (settled) return;
    try {
      assertImageDimensions(image);
      settled = true;
      cleanup();
      resolve(image);
    } catch (error) {
      fail(error as Error);
    }
  };
  image.onerror = () => fail(new Error('PA_ERROR_IMAGE_UNAVAILABLE'));
  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  image.src = source;
});

export const releaseImage = (image?: HTMLImageElement | null) => {
  if (image) image.src = '';
};

export const releaseCanvas = (canvas?: HTMLCanvasElement | null) => {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
};

export const blobToSafeDataUrl = async (blob: Blob): Promise<string> => {
  assertBlobSize(blob);
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? '');
      try {
        assertDataUrlSize(value);
        resolve(value);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('PA_ERROR_RETRIEVE_ASSET'));
    reader.readAsDataURL(blob);
  });
};

export const canvasToBase64 = async (
  canvas: HTMLCanvasElement,
  format: 'png' | 'jpg',
  quality = 0.92
): Promise<string> => {
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => result ? resolve(result) : reject(new Error('PA_ERROR_EMPTY_IMAGE')),
      mime,
      format === 'jpg' ? quality : undefined
    );
  });
  assertBlobSize(blob);
  const data = (await blobToSafeDataUrl(blob)).split(',', 2)[1] ?? '';
  if (!data) throw new Error('PA_ERROR_EMPTY_IMAGE');
  assertBase64PayloadSize(data);
  return data;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const fetchWithCancellation = async (
  fetcher: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs = IMAGE_FETCH_TIMEOUT_MS
): Promise<Response> => {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('PA_ERROR_OPERATION_TIMEOUT');
    throw error;
  } finally {
    window.clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
};

let compositionTail: Promise<void> = Promise.resolve();
let steamArtworkWriteTail: Promise<void> = Promise.resolve();

export const withCompositionLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = compositionTail;
  let release!: () => void;
  compositionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

export const withSteamArtworkWriteLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = steamArtworkWriteTail;
  let release!: () => void;
  steamArtworkWriteTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

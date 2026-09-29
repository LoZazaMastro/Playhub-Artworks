import { call } from '@decky/api';
import { artworkMime } from './imageMetadata';
import { base64ToBlob, fetchLocalImageBlob, MAX_SOURCE_BYTES, throwIfImageCancelled } from './imageSafety';
import { ArtworkPayload, normalizeArtworkBlob } from './normalizeArtworkPayload';
import { isRuntimeActive, onRuntimeStop } from './runtimeLifecycle';

interface TransferInfo {
  token: string;
  size: number;
  chunk_size: number;
  format: string;
  sha256?: string;
  dimensions?: [number, number];
  animated?: boolean;
}
interface TransferOptions {
  path?: boolean;
  signal?: AbortSignal;
  jobId?: string;
  progress?: (percent: number) => void;
  perfectSource?: { appId: number; target: 'hero' | 'grid_l' };
  preserve?: { appId: number; target: 'hero' | 'grid_l'; replace?: boolean };
  staticOnly?: boolean;
  retainSource?: boolean; // Caller must release transferToken after committing or abandoning.
}

/** Source bytes never travel in a single Decky/WebSocket message. */
export const readArtworkPayload = async (location: string, options: TransferOptions = {}): Promise<ArtworkPayload | null> => {
  const jobId = options.jobId || `pa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const controller = new AbortController();
  const signal = controller.signal;
  let token = '';
  let retained = false;
  let preparing = true;
  const abort = () => {
    controller.abort();
    if (preparing) void call('cancel_artwork_transfer', jobId).catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const unsubscribe = onRuntimeStop(abort);
  if (options.signal?.aborted || !isRuntimeActive()) abort();
  try {
    throwIfImageCancelled(signal);
    const info = options.perfectSource
      ? await call<[number, string, string], TransferInfo | null>('prepare_perfect_source_transfer', options.perfectSource.appId, options.perfectSource.target, jobId)
      : await call<[string, string, string], TransferInfo>('prepare_artwork_transfer', options.path ? '' : location, options.path ? location : '', jobId);
    preparing = false;
    token = info?.token || '';
    throwIfImageCancelled(signal);
    if (!info && options.perfectSource) return null;
    if (!info?.token || !Number.isSafeInteger(info.size) || info.size <= 0 || info.size > MAX_SOURCE_BYTES
      || !Number.isSafeInteger(info.chunk_size) || info.chunk_size <= 0 || info.chunk_size > 384 * 1024) {
      throw new Error('PA_ERROR_INVALID_ARTWORK');
    }
    if (options.staticOnly && info.animated) throw new Error('PA_ERROR_STATIC_ARTWORK_REQUIRED');
    const parts: Blob[] = [];
    let received = 0;
    for (let offset = 0; offset < info.size; offset += info.chunk_size) {
      throwIfImageCancelled(signal);
      const data = await call<[string, number], string>('read_artwork_transfer_chunk', token, offset);
      throwIfImageCancelled(signal);
      if (typeof data !== 'string' || !data || data.length > Math.ceil(info.chunk_size / 3) * 4) throw new Error('PA_ERROR_INCOMPLETE_DOWNLOAD');
      const part = base64ToBlob(data, 'application/octet-stream');
      const expected = Math.min(info.chunk_size, info.size - offset);
      if (part.size !== expected) throw new Error('PA_ERROR_INCOMPLETE_DOWNLOAD');
      parts.push(part);
      received += part.size;
      options.progress?.(60 + 20 * received / info.size);
    }
    if (received !== info.size) throw new Error('PA_ERROR_INCOMPLETE_DOWNLOAD');
    const blob = new Blob(parts, { type: artworkMime(info.format) });
    parts.length = 0;
    const normalized = await normalizeArtworkBlob(blob, signal);
    if (options.staticOnly && normalized.animated) throw new Error('PA_ERROR_STATIC_ARTWORK_REQUIRED');
    throwIfImageCancelled(signal);
    if (options.preserve) {
      const saved = await call<[number, string, string, boolean], { saved?: boolean }>(
        'preserve_perfect_source_from_transfer', options.preserve.appId, options.preserve.target, token, Boolean(options.preserve.replace)
      );
      if (!saved?.saved) throw new Error('PA_ERROR_SOURCE_NOT_PRESERVED');
    }
    retained = Boolean(options.retainSource);
    return { ...normalized, sha256: info.sha256, transferToken: retained ? token : undefined };
  } catch (error) {
    throwIfImageCancelled(signal);
    throw error;
  } finally {
    preparing = false;
    options.signal?.removeEventListener('abort', abort);
    unsubscribe();
    if (token && !retained) await call('release_artwork_transfer', token).catch(() => undefined);
    if (!options.jobId) void call('clear_download_progress', jobId).catch(() => undefined);
  }
};

/** Loopback artwork must be fetched by Steam's renderer, not Decky's remote proxy. */
export const readArtworkSource = async (source: string, options: TransferOptions = {}): Promise<ArtworkPayload | null> => {
  if (!source) return null;
  // Steam's stores also return root-relative customimages URLs. Resolve them
  // against Steam, including when the caller lives in an about:blank popup.
  const localSource = /^\/(?!\/)/.test(source)
    ? new URL(source, 'https://steamloopback.host').href : source;
  if (/^(?:data:|blob:|https?:\/\/(?:steamloopback\.host|localhost|127\.0\.0\.1)(?::\d+)?\/)/i.test(localSource)) {
    const result = await normalizeArtworkBlob(await fetchLocalImageBlob(localSource, options.signal), options.signal);
    if (options.staticOnly && result.animated) throw new Error('PA_ERROR_STATIC_ARTWORK_REQUIRED');
    return result;
  }
  return await readArtworkPayload(source, options);
};

export const artworkPayloadUrl = (payload: ArtworkPayload) => `data:${artworkMime(payload.format)};base64,${payload.data}`;

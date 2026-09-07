import { call } from '@decky/api';

import { ASSET_TYPE } from '../constants';
import getCurrentSteamUserId from './getCurrentSteamUserId';
import { normalizeArtworkPayload } from './normalizeArtworkPayload';

export const DERIVED_COVER_MAX_CHUNK_BYTES = 252 * 1024;
const STEAM_ARTWORK_TIMEOUT_MS = 10_000;

export interface DerivedCoverBackupInfo {
  exists?: boolean;
  is_derived?: boolean;
  recoverable?: boolean;
  state?: 'preserved' | 'pending' | 'derived' | 'restoring';
  had_custom?: boolean;
  size?: number;
  mime?: string;
  format?: string;
  sha256?: string;
  chunk_size?: number;
}

const delay = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const withTimeout = async <T>(operation: Promise<T>, timeout = 12_000): Promise<T> => {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error('PA_ERROR_OPERATION_TIMEOUT')), timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
};

type SteamArtworkMutation = <T>(message: string, operation: () => Promise<T> | T) => Promise<T>;
type SteamArtworkTransaction<T> = (mutate: SteamArtworkMutation) => Promise<T>;
type RecoveryError = Error & {
  steamArtworkPending?: Promise<void>;
  steamArtworkRecovery?: Promise<void>;
};
type QueueEntry = {
  operation: SteamArtworkTransaction<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const recoveryError = (message: string, recovery: Promise<void>, pending = false): RecoveryError => {
  const error = new Error(message) as RecoveryError;
  if (pending) error.steamArtworkPending = recovery;
  else error.steamArtworkRecovery = recovery;
  return error;
};

/**
 * Serialize Steam artwork mutations without ever running a rollback beside a late
 * Clear/Set Promise. A timeout rejects callers promptly and quarantines the queue;
 * new and already queued work fails closed until the live Steam Promise settles.
 */
export const createSteamArtworkMutationQueue = (timeoutMs = STEAM_ARTWORK_TIMEOUT_MS) => {
  const entries: QueueEntry[] = [];
  let draining = false;
  let quarantine: Promise<void> | null = null;

  const mutate: SteamArtworkMutation = async <T>(message: string, operation: () => Promise<T> | T) => {
    let live: Promise<T>;
    try {
      live = Promise.resolve(operation());
    } catch (error) {
      throw error;
    }

    let timer: number | undefined;
    type Outcome = { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' };
    const outcome = await Promise.race<Outcome>([
      live.then<Outcome, Outcome>(
        (value) => ({ kind: 'value', value }),
        (error) => ({ kind: 'error', error }),
      ),
      new Promise<Outcome>((resolve) => {
        timer = window.setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
    if (timer !== undefined) window.clearTimeout(timer);
    if (outcome.kind === 'error') throw outcome.error;
    if (outcome.kind === 'timeout') {
      const pending = live.then(() => undefined, () => undefined);
      throw recoveryError(message, pending, true);
    }
    return outcome.value;
  };

  const drain = async (): Promise<void> => {
    if (draining || quarantine) return;
    draining = true;
    while (entries.length > 0) {
      const entry = entries.shift()!;
      try {
        entry.resolve(await entry.operation(mutate));
      } catch (error) {
        const pending = (error as RecoveryError)?.steamArtworkPending;
        if (!pending) {
          entry.reject(error);
          continue;
        }

        let recovery!: Promise<void>;
        recovery = pending.finally(() => {
          if (quarantine !== recovery) return;
          quarantine = null;
          draining = false;
          void drain();
        });
        quarantine = recovery;
        entry.reject(recoveryError((error as Error).message, recovery));
        for (const blocked of entries.splice(0)) {
          blocked.reject(recoveryError('PA_ERROR_STEAM_ARTWORK_QUEUE_BUSY', recovery));
        }
        return;
      }
    }
    draining = false;
  };

  const run = <T>(operation: SteamArtworkTransaction<T>): Promise<T> => {
    if (quarantine) {
      return Promise.reject(recoveryError('PA_ERROR_STEAM_ARTWORK_QUEUE_BUSY', quarantine));
    }
    return new Promise<T>((resolve, reject) => {
      entries.push({
        operation: operation as SteamArtworkTransaction<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void drain();
    });
  };

  const deferUntilRecovered = (error: unknown, operation: () => Promise<void>): boolean => {
    const recovery = (error as RecoveryError)?.steamArtworkRecovery;
    if (!recovery) return false;
    void recovery.then(operation).catch(() => undefined);
    return true;
  };

  return {
    run,
    deferUntilRecovered,
    isQuarantined: () => quarantine !== null,
  };
};

const steamArtworkQueue = createSteamArtworkMutationQueue();

export const runSteamArtworkTransaction = steamArtworkQueue.run;
export const deferSteamArtworkQueueRecovery = steamArtworkQueue.deferUntilRecovered;

export const clearSteamArtworkSafely = async (appId: number, assetType: number, settleMs = 180): Promise<void> => {
  await runSteamArtworkTransaction(async (mutate) => {
    await mutate('Clear artwork timeout', () => SteamClient.Apps.ClearCustomArtworkForApp(appId, assetType));
    if (settleMs > 0) await delay(settleMs);
  });
};

const sha256Base64 = async (data: string): Promise<string> => {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
};

export const getDerivedCoverBackupInfo = async (appId: number): Promise<DerivedCoverBackupInfo> => {
  try {
    return await withTimeout(call<[string, number], DerivedCoverBackupInfo>(
      'get_derived_cover_backup_info', getCurrentSteamUserId(), appId
    ));
  } catch (_) {
    return { exists: false, is_derived: false };
  }
};

export const clearDerivedCoverBackup = async (appId: number): Promise<void> => {
  const cleared = await withTimeout(call<[string, number], boolean>(
    'clear_derived_cover_backup', getCurrentSteamUserId(), appId
  ));
  if (!cleared) throw new Error('PA_ERROR_COVER_BACKUP_FAILED');
};

const restoreWrites = new Map<number, Promise<void>>();

export const restoreDerivedCover = async (appId: number, allowPending = false): Promise<void> => {
  const pending = restoreWrites.get(appId);
  if (pending) return pending;

  const operation = (async () => {
    const steamUser = getCurrentSteamUserId();
    const initial = await getDerivedCoverBackupInfo(appId);
    if (!initial.exists || !(initial.recoverable ?? initial.is_derived)) {
      throw new Error('PA_ERROR_DERIVED_COVER_RESTORE_FAILED');
    }
    const interrupted = initial.state === 'pending' || initial.state === 'restoring';
    const begun = await call<[string, number, boolean], boolean>(
      'begin_derived_cover_restore', steamUser, appId, allowPending || interrupted
    );
    if (!begun) throw new Error('PA_ERROR_DERIVED_COVER_RESTORE_FAILED');

    let originalData = '';
    if (initial.had_custom) {
      const size = Number(initial.size || 0);
      const chunkSize = Number(initial.chunk_size || 0);
      if (
        size <= 0
        || chunkSize <= 0
        || chunkSize > DERIVED_COVER_MAX_CHUNK_BYTES
        || chunkSize % 3 !== 0
        || !initial.format
        || !initial.sha256
      ) {
        throw new Error('PA_ERROR_DERIVED_COVER_RESTORE_FAILED');
      }
      const chunks: string[] = [];
      for (let offset = 0; offset < size; offset += chunkSize) {
        const chunk = await call<[string, number, number], string>(
          'read_derived_cover_backup_chunk', steamUser, appId, offset
        );
        if (!chunk) throw new Error('PA_ERROR_DERIVED_COVER_RESTORE_FAILED');
        chunks.push(chunk);
      }
      originalData = chunks.join('');
      if (await sha256Base64(originalData) !== initial.sha256) {
        throw new Error('PA_ERROR_DERIVED_COVER_RESTORE_FAILED');
      }
    }

    const normalized = initial.had_custom
      ? await normalizeArtworkPayload({ data: originalData, format: String(initial.format || '') })
      : null;
    const restoredDigest = normalized ? await sha256Base64(normalized.data) : '';
    const prepared = await call<[string, number, string], boolean>(
      'prepare_derived_cover_restore', steamUser, appId, restoredDigest
    );
    if (!prepared) throw new Error('PA_ERROR_DERIVED_COVER_RESTORE_FAILED');

    await runSteamArtworkTransaction(async (mutate) => {
      await mutate(
        'Clear artwork timeout',
        () => SteamClient.Apps.ClearCustomArtworkForApp(appId, ASSET_TYPE.grid_p),
      );
      await delay(180);
      if (normalized) {
        await mutate(
          'Set artwork timeout',
          () => SteamClient.Apps.SetCustomArtworkForApp(
            appId,
            normalized.data,
            normalized.format,
            ASSET_TYPE.grid_p,
          ),
        );
      }
    });

    let completed = false;
    for (let attempt = 0; attempt < 8 && !completed; attempt += 1) {
      completed = await call<[string, number], boolean>(
        'complete_derived_cover_restore', steamUser, appId
      ).catch(() => false);
      if (!completed) await delay(160);
    }
    if (!completed) throw new Error('PA_ERROR_DERIVED_COVER_RESTORE_FAILED');
  })();

  restoreWrites.set(appId, operation);
  try {
    await operation;
  } finally {
    if (restoreWrites.get(appId) === operation) restoreWrites.delete(appId);
  }
};


import { useSyncExternalStore } from 'react';

export type ArtworkJobStatus = 'running' | 'success' | 'error';

export interface ArtworkJob {
  key: string;
  targetKey: string;
  appId: number;
  assetType: SGDBAssetType | eAssetType;
  identity: string;
  progress: number;
  status: ArtworkJobStatus;
  error?: string;
}

const listeners = new Set<() => void>();
const jobs = new Map<string, ArtworkJob>();
const runningTargets = new Map<string, { key: string; promise: Promise<any> }>();
let snapshot: ArtworkJob[] = [];

const emit = () => {
  snapshot = Array.from(jobs.values());
  listeners.forEach((listener) => listener());
};

const update = (key: string, patch: Partial<ArtworkJob>) => {
  const current = jobs.get(key);
  if (!current) return;
  jobs.set(key, { ...current, ...patch });
  emit();
};

const removeLater = (key: string, delay: number) => {
  window.setTimeout(() => {
    if (jobs.delete(key)) emit();
  }, delay);
};

export const artworkTargetKey = (appId: number, assetType: SGDBAssetType | eAssetType) => `${appId}:${assetType}`;

export const artworkJobKey = (appId: number, assetType: SGDBAssetType | eAssetType, identity: string) =>
  `${artworkTargetKey(appId, assetType)}:${String(identity || '').trim()}`;

export const isArtworkTargetBusy = (appId: number, assetType: SGDBAssetType | eAssetType) =>
  runningTargets.has(artworkTargetKey(appId, assetType));

export const runArtworkJob = async <T>(
  appId: number,
  assetType: SGDBAssetType | eAssetType,
  identity: string,
  runner: (reportProgress: (progress: number) => void) => Promise<T>
): Promise<T> => {
  const targetKey = artworkTargetKey(appId, assetType);
  const key = artworkJobKey(appId, assetType, identity);
  const existing = runningTargets.get(targetKey);
  if (existing) {
    if (existing.key === key) return await existing.promise;
    throw new Error('Attendi il completamento dell’artwork già in applicazione.');
  }

  jobs.set(key, { key, targetKey, appId, assetType, identity, progress: 5, status: 'running' });
  emit();

  const progressTimer = window.setInterval(() => {
    const current = jobs.get(key);
    if (!current || current.status !== 'running') return;
    if (current.progress < 12) update(key, { progress: Math.min(12, current.progress + 0.5) });
  }, 180);

  const reportProgress = (progress: number) => update(key, {
    progress: Math.max(2, Math.min(99, Number(progress) || 0)),
  });

  const promise = (async () => {
    try {
      const result = await runner(reportProgress);
      update(key, { progress: 100, status: 'success' });
      removeLater(key, 3500);
      return result;
    } catch (error: any) {
      update(key, { progress: 100, status: 'error', error: error?.message ?? String(error) });
      removeLater(key, 6000);
      throw error;
    } finally {
      window.clearInterval(progressTimer);
      runningTargets.delete(targetKey);
    }
  })();

  runningTargets.set(targetKey, { key, promise });
  return await promise;
};

export const subscribeArtworkJobs = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getArtworkJobsSnapshot = () => snapshot;

export const useArtworkJobs = () => useSyncExternalStore(
  subscribeArtworkJobs,
  getArtworkJobsSnapshot,
  getArtworkJobsSnapshot
);

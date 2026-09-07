import { useSyncExternalStore } from 'react';

import { runZazaMastroBatch, ZazaBatchKind, ZazaBatchProgress } from './zazamastroBatch';
import t, { localizeError } from './i18n';

export interface BulkArtworkJob extends ZazaBatchProgress {
  kind: ZazaBatchKind;
}

const listeners = new Set<() => void>();
let snapshot: BulkArtworkJob | null = null;
let running: Promise<ZazaBatchProgress> | null = null;
let controller: AbortController | null = null;

const publish = (kind: ZazaBatchKind, progress: ZazaBatchProgress) => {
  snapshot = { ...progress, kind };
  listeners.forEach((listener) => listener());
};

export const cancelBulkArtworkJob = () => controller?.abort();

export const startBulkArtworkJob = async (kind: ZazaBatchKind, steamWrites = 2) => {
  if (running) return await running;
  publish(kind, {
    total: 0,
    processed: 0,
    changed: 0,
    skipped: 0,
    failed: 0,
    message: t('PA_READING_LIBRARY', 'Reading the library'),
    running: true,
  });
  const jobController = new AbortController();
  controller = jobController;
  running = runZazaMastroBatch(kind, (progress) => publish(kind, progress), steamWrites, jobController.signal);
  try {
    return await running;
  } catch (error: any) {
    const current = snapshot;
    const cancelled = error?.name === 'AbortError';
    const message = cancelled
      ? t('PA_OPERATION_CANCELLED', 'Operation cancelled')
      : localizeError(error, 'PA_FAILED');
    publish(kind, {
      total: current?.total ?? 0,
      processed: current?.processed ?? 0,
      changed: current?.changed ?? 0,
      skipped: current?.skipped ?? 0,
      failed: current?.failed ?? 0,
      current: current?.current,
      lastError: cancelled ? current?.lastError : message,
      message,
      running: false,
    });
    throw error;
  } finally {
    running = null;
    if (controller === jobController) controller = null;
  }
};

export const subscribeBulkArtworkJob = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getBulkArtworkJobSnapshot = () => snapshot;

export const useBulkArtworkJob = () => useSyncExternalStore(
  subscribeBulkArtworkJob,
  getBulkArtworkJobSnapshot,
  getBulkArtworkJobSnapshot
);

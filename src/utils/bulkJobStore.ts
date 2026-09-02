import { useSyncExternalStore } from 'react';

import { runZazaMastroBatch, ZazaBatchKind, ZazaBatchProgress } from './zazamastroBatch';

export interface BulkArtworkJob extends ZazaBatchProgress {
  kind: ZazaBatchKind;
}

const listeners = new Set<() => void>();
let snapshot: BulkArtworkJob | null = null;
let running: Promise<ZazaBatchProgress> | null = null;

const publish = (kind: ZazaBatchKind, progress: ZazaBatchProgress) => {
  snapshot = { ...progress, kind };
  listeners.forEach((listener) => listener());
};

export const startBulkArtworkJob = async (kind: ZazaBatchKind, steamWrites = 6) => {
  if (running) return await running;
  publish(kind, {
    total: 0,
    processed: 0,
    changed: 0,
    skipped: 0,
    failed: 0,
    message: 'Lettura della libreria',
    running: true,
  });
  running = runZazaMastroBatch(kind, (progress) => publish(kind, progress), steamWrites);
  try {
    return await running;
  } catch (error) {
    const current = snapshot;
    publish(kind, {
      total: current?.total ?? 0,
      processed: current?.processed ?? 0,
      changed: current?.changed ?? 0,
      skipped: current?.skipped ?? 0,
      failed: current?.failed ?? 0,
      current: current?.current,
      message: 'Operazione interrotta',
      running: false,
    });
    throw error;
  } finally {
    running = null;
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

import { call } from '@decky/api';
import { isRuntimeActive, onRuntimeStop } from './runtimeLifecycle';

/** No concurrent progress RPCs, unhandled rejections, or polling after plugin unload. */
export const watchDownloadProgress = (jobId: string, report?: (progress: number) => void): (() => void) => {
  let stopped = false;
  let inFlight = false;
  let timer: number | undefined;
  let unsubscribe = () => undefined as void;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    unsubscribe();
  };
  if (report && isRuntimeActive()) {
    timer = window.setInterval(() => {
      if (stopped || inFlight || !isRuntimeActive()) return;
      inFlight = true;
      void call<[string], { percent?: number }>('get_download_progress', jobId)
        .then(progress => { if (!stopped && isRuntimeActive()) report(Math.min(80, Number(progress?.percent ?? 0) * .8)); })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    }, 350);
    unsubscribe = onRuntimeStop(stop);
  }
  return stop;
};

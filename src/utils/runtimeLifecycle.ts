/** Shared lifecycle for short-lived polling jobs that can outlive a React page. */
let active = true;
const cleanups = new Set<() => void>();
export const isRuntimeActive = () => active;
export const startRuntime = () => { active = true; };
export const onRuntimeStop = (cleanup: () => void): (() => void) => {
  if (!active) { cleanup(); return () => undefined; }
  cleanups.add(cleanup);
  return () => { cleanups.delete(cleanup); };
};
export const stopRuntime = () => {
  active = false;
  for (const cleanup of cleanups) {
    try { cleanup(); } catch { /* Other jobs still need to stop. */ }
  }
  cleanups.clear();
};

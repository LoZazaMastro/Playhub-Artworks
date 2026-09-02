/*
  What the plugin is doing right now, in one word.

  The frame watcher reports the gaps; this says what was running when a gap happened. It is
  deliberately a single string with no history: it costs one assignment, and a diagnostic
  that costs anything measurable would be measuring itself.
*/
let work = '';

export const markWork = (what: string) => { work = what; };

export const currentWork = (): string => work;

/** Runs `body` with the work named, so a stutter during it can be attributed. */
export const whileWorking = <T>(what: string, body: () => T): T => {
  markWork(what);
  try {
    return body();
  } finally {
    markWork('');
  }
};

import { findSP } from '@decky/ui';

/*
  Every helper here is defensive on purpose.

  `findSP()` throws while Steam is still building its UI, which is exactly when the plugin
  mounts on a cold start. The throw propagated out of `addSquareLibraryPatch`, aborted
  `refreshLayoutPatches` before it could schedule its retry, and the library cover format
  was silently never applied for the rest of the session. Now a failure is reported to the
  caller, which retries, instead of taking the whole layout setup down with it.
*/
const uiDocument = (): Document | null => {
  try {
    return findSP()?.window?.document ?? null;
  } catch (_) {
    return null;
  }
};

/*
  What was injected, kept so it can be put back.

  Closing Big Picture and opening it again REBUILDS Steam's interface: the plugin's
  javascript keeps running with all its patches alive, but the document it wrote its
  `<style>` into is gone. The result is the worst possible half-state - the carousel is
  still being told to use square column widths while the CSS that squares the capsule no
  longer exists, so every cover is drawn portrait at square width: "verticali e più alte
  del normale". Remembering the css here is what makes putting it back possible.
*/
const injected = new Map<string, string>();

/**
 * Puts back any style that is no longer in the current document.
 *
 * @returns the ids that had to be re-injected - empty when nothing was missing.
 */
export const restoreStylesTo = (doc: Document | null | undefined): string[] => {
  if (!doc?.head) return [];
  const restored: string[] = [];
  injected.forEach((css, id) => {
    try {
      if (doc.getElementById(id)) return;
      const styleEl = doc.createElement('style');
      styleEl.id = id;
      styleEl.textContent = css;
      doc.head.append(styleEl);
      restored.push(id);
    } catch (_) {
      // Steam UI mid-rebuild; the next beat tries again.
    }
  });
  return restored;
};

export const restoreStyles = (): string[] => restoreStylesTo(uiDocument());

/** True when the style is in place. */
export const addStyle = (id: string, css: string): boolean => {
  const doc = uiDocument();
  if (!doc?.head) return false;
  try {
    injected.set(id, css);
    if (doc.getElementById(id)) return true;
    const styleEl = doc.createElement('style');
    styleEl.id = id;
    styleEl.textContent = css;
    doc.head.append(styleEl);
    return true;
  } catch (_) {
    return false;
  }
};

export const removeStyle = (id: string) => {
  injected.delete(id);
  try {
    uiDocument()?.getElementById(id)?.remove();
  } catch (_) {
    // Steam UI already gone.
  }
};

/** Updates the style if it exists, creates it if not. Returns true when it is in place. */
export const updateStyle = (id: string, css: string): boolean => {
  const doc = uiDocument();
  if (!doc?.head) return false;
  try {
    injected.set(id, css);
    const existing = doc.getElementById(id);
    if (existing) {
      existing.textContent = css;
      return true;
    }
  } catch (_) {
    return false;
  }
  return addStyle(id, css);
};

export const removeStyles = (...ids: string[]) => {
  ids.forEach(removeStyle);
};

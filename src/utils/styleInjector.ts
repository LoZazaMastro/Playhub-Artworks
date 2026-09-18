import { findSteamUI } from './steamWindow';

const injected = new Map<string, string>();
const documents = new Set<Document>();
const uiDocument = (): Document | null => findSteamUI()?.window.document ?? null;

const upsert = (doc: Document | null | undefined, id: string, css: string): boolean => {
  if (!doc?.head) return false;
  try {
    documents.add(doc);
    let element = doc.getElementById(id);
    if (!element) {
      element = doc.createElement('style');
      element.id = id;
      element.textContent = css;
      doc.head.append(element);
    } else if (element.textContent !== css) {
      element.textContent = css;
    }
    return true;
  } catch { return false; }
};

/** Retain desired CSS even when Steam has not constructed its document yet. */
export const addStyle = (id: string, css: string): boolean => {
  injected.set(id, css);
  return upsert(uiDocument(), id, css);
};
export const updateStyle = addStyle;

export const restoreStylesTo = (doc: Document | null | undefined): string[] => {
  if (!doc?.head) return [];
  const restored: string[] = [];
  injected.forEach((css, id) => {
    try {
      if (doc.getElementById(id)?.textContent === css) return;
      if (upsert(doc, id, css)) restored.push(id);
    } catch { /* Retry on the next layout beat. */ }
  });
  return restored;
};
export const restoreStyles = (): string[] => restoreStylesTo(uiDocument());

export const removeStyle = (id: string) => {
  injected.delete(id);
  const current = uiDocument();
  if (current) documents.add(current);
  try {
    for (const entry of (window as any).SteamUIStore?.WindowStore?.SteamUIWindows ?? []) {
      try { if (entry.BrowserWindow?.document) documents.add(entry.BrowserWindow.document); } catch { /* Closed. */ }
    }
  } catch { /* Steam is shutting down. */ }
  for (const doc of documents) {
    try { doc.getElementById(id)?.remove(); } catch { /* Closed. */ }
  }
  if (!injected.size) documents.clear();
};
export const removeStyles = (...ids: string[]) => ids.forEach(removeStyle);

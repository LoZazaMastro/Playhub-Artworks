import { call } from '@decky/api';

import { steamPath } from './steamRoute';

const queue: any[] = [];
let flushTimer: number | undefined;

const serialize = (value: any, depth: number, seen: WeakSet<object>): any => {
  if (value instanceof Error) return { type: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'string') {
    const safeValue = /^https?:\/\//i.test(value) ? value.replace(/([?#]).*$/, '') : value;
    return safeValue.length > 500 ? `${safeValue.slice(0, 500)}…` : safeValue;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= 3) return Array.isArray(value) ? `[array:${value.length}]` : `[object:${value.constructor?.name ?? 'Object'}]`;
  seen.add(value);
  if (value.$$typeof || value._owner) return { type: 'react-element', key: value.key ?? null };
  if (Array.isArray(value)) return {
    type: 'array',
    length: value.length,
    items: value.slice(0, 12).map((item) => serialize(item, depth + 1, seen)),
  };
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [
      key,
      /api.?key|authorization|cookie|token|secret|password/i.test(key) ? '[redacted]' : serialize(item, depth + 1, seen),
    ]));
  }
  return value;
};

const safeSerialize = (value: any) => {
  /*
    The logger must never be the thing that throws. `JSON.stringify` returns
    `undefined` for undefined / functions / symbols, and reading `.length` off that
    used to blow up inside `log()` itself - swallowing the very error being logged.
  */
  try {
    const serialized = serialize(value, 0, new WeakSet());
    const encoded = JSON.stringify(serialized);
    if (typeof encoded !== 'string') return { type: typeof value };
    return encoded.length > 8000 ? { type: 'truncated', bytes: encoded.length } : serialized;
  } catch (_) {
    return { type: 'unserializable' };
  }
};

const flush = () => {
  flushTimer = undefined;
  const events = queue.splice(0, 20);
  if (events.length) void call('write_diagnostic_events', events).catch(() => undefined);
  if (queue.length) flushTimer = window.setTimeout(flush, 350);
};

export default (...params: any[]) => {
  if (process.env.ROLLUP_ENV !== 'production') window.console.log('[Playhub Artworks]', ...params);
  if (queue.length >= 200) queue.splice(0, queue.length - 199);
  queue.push({ timestamp: new Date().toISOString(), route: steamPath(), params: params.map(safeSerialize) });
  if (!flushTimer) flushTimer = window.setTimeout(flush, 350);
};

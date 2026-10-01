import { current, isDraft } from 'immer';

/** Deep-copy a value that may be an immer draft (structuredClone can't clone proxies). */
export function deepClone<T>(v: T): T {
  return structuredClone(isDraft(v) ? (current(v as object) as T) : v);
}

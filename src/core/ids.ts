/** Short, collision-resistant ids for project entities. */
export function uid(prefix = ''): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(36).padStart(2, '0');
  return prefix ? `${prefix}_${s.slice(0, 14)}` : s.slice(0, 14);
}

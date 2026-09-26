/**
 * The host part of a URL: `https://pheonix.tail47eac7.ts.net` →
 * `pheonix.tail47eac7.ts.net`, `http://10.0.2.2:4000/` → `10.0.2.2`.
 *
 * Parsed by hand because React Native's `URL` has historically left
 * `hostname` unimplemented, and this runs on every platform.
 */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const rest = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = rest.split(/[/?#]/)[0].replace(/^[^@]*@/, '');
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end > 0 ? authority.slice(1, end) : null;
  }
  const host = authority.split(':')[0];
  return host || null;
}

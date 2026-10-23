// R476-fix (#468 diagnosis): the URL vocabulary shared by the timeline recorder, the verdict and
// the injections. Its own module so `reveal-page-hook.mjs` can stay free of module-scope imports
// (it is serialized into the document) without either consumer owning the constants.
export const NOTE_API_PATH = '/api/web/v1/note';
export const VAULTS_API_PATH = '/api/web/v1/vaults';
export const TREE_API_PATH = '/api/web/v2/tree';
export const FAMILIES = new Map([[NOTE_API_PATH, 'note'], [VAULTS_API_PATH, 'vaults'], [TREE_API_PATH, 'tree']]);
export const BODY_FAMILIES = new Set(['note', 'vaults']);

export function parseUrl(url) {
  try { return new URL(url, 'http://reveal.invalid'); } catch { return null; }
}
export function familyOf(url) {
  const parsed = parseUrl(url);
  return parsed ? FAMILIES.get(parsed.pathname) ?? null : null;
}
export function displayPath(url) {
  const parsed = parseUrl(url);
  return parsed ? `${parsed.pathname}${parsed.search}` : String(url);
}
export function isTargetNoteUrl(url, notePath) {
  const parsed = parseUrl(url);
  return Boolean(parsed)
    && parsed.pathname === NOTE_API_PATH
    && parsed.searchParams.get('path') === notePath;
}
export function noteRequestPath(notePath) {
  return `${NOTE_API_PATH}?path=${encodeURIComponent(notePath)}`;
}

export const themes = [
  { id: 'white', name: '白色', color: '#ffffff' },
  { id: 'polar-purple', name: '极地紫', color: '#16141c' },
];
const storageKey = 'aw.theme';
const normalizeTheme = value => themes.some(theme => theme.id === value) ? value : 'white';

export function readTheme() {
  try { return normalizeTheme(localStorage.getItem(storageKey)); }
  catch { return 'white'; }
}

export function applyTheme(value) {
  const id = normalizeTheme(value);
  document.documentElement.dataset.theme = id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themes.find(theme => theme.id === id).color);
  return id;
}

export function saveTheme(value) {
  const id = applyTheme(value);
  // Storage can be unavailable in private or restricted browser contexts.
  try { localStorage.setItem(storageKey, id); } catch {}
  return id;
}

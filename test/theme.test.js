import test from 'node:test';
import assert from 'node:assert/strict';
import { themes, readTheme, applyTheme, saveTheme } from '../web/src/theme.js';

test('theme defaults, persistence and restricted storage', t => {
  const values = new Map();
  const root = { dataset: {} };
  let browserColor;
  for (const [key, value] of Object.entries({
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    document: { documentElement: root, querySelector: () => ({ setAttribute: (key, value) => { browserColor = value; } }) },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }

  assert.deepEqual(themes.map(theme => theme.name), ['白色', '极地紫']);
  assert.equal(readTheme(), 'white');
  assert.equal(applyTheme(readTheme()), 'white');
  assert.equal(root.dataset.theme, 'white');
  assert.equal(browserColor, '#ffffff');

  assert.equal(saveTheme('polar-purple'), 'polar-purple');
  assert.equal(readTheme(), 'polar-purple');
  assert.equal(root.dataset.theme, 'polar-purple');
  assert.equal(browserColor, '#16141c');
  assert.equal(saveTheme('white'), 'white');
  assert.equal(readTheme(), 'white');

  values.set('aw.theme', 'invalid');
  assert.equal(readTheme(), 'white');
  assert.equal(applyTheme('invalid'), 'white');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  assert.equal(readTheme(), 'white');
  assert.equal(saveTheme('polar-purple'), 'polar-purple');
  assert.equal(root.dataset.theme, 'polar-purple');
});

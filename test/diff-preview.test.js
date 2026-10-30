import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { parse, compileScript } from 'vue/compiler-sfc';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../web/src/DiffPreview.vue', import.meta.url), 'utf8');
const { descriptor } = parse(source);
const compiled = compileScript(descriptor, { id: 'diff-preview-test', inlineTemplate: true });
const code = compiled.content.replace(/from (["'])([^"']+)\1/g, (_, quote, name) => `from ${quote}${pathToFileURL(require.resolve(name)).href}${quote}`);
const { default: DiffPreview } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const render = diff => renderToString(createSSRApp(DiffPreview, { diff }));

test('shared diff preview renders files, colored changes and escaped code', async () => {
  const html = await render({ available: true, status: ' M src/app.js', diff: '@@ -1 +1 @@\n-old\n+<script>alert(1)</script>' });
  assert.match(html, /src\/app\.js/);
  assert.match(html, /class="hunk"/);
  assert.match(html, /class="deletion"/);
  assert.match(html, /class="addition"/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>'));
});

test('shared diff preview preserves empty states and truncation warning', async () => {
  assert.match(await render({ available: true }), /工作区很干净/);
  assert.match(await render({ available: false }), /等待代码变更/);
  assert.match(await render({ available: true, status: '?? new.txt' }), /当前无可展示的文本差异/);
  assert.match(await render({ diff: '+code', truncated: true }), /200 KB/);
});

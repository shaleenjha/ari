import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * S2 icons (v18.17.0): the package sprite (src/ui/icons/sprite.svg, Phosphor MIT + custom, 24 grid, 1.5 stroke) is inlined
 * into index.html at build and in dev, so <use href="#ari-…"> resolves on the first paint and offline with no extra
 * request. Hidden by size, not display:none, so WebKit still renders the referenced symbols.
 */
function inlineSprite(): Plugin {
  const svg = () => readFileSync(new URL('./src/ui/icons/sprite.svg', import.meta.url), 'utf8').trim()
    .replace(/^<svg\b[^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" id="ari-sprite">');
  return { name: 'ari-inline-sprite', transformIndexHtml: { order: 'pre', handler: (html) => html.replace('<!-- ari:sprite -->', svg()) } };
}

export default defineConfig({
  plugins: [react(), inlineSprite()],
  build: { target: 'es2022', sourcemap: true },
  test: { include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'], environment: 'node' },
});

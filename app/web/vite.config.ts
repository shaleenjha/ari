import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  // B+ shell (b.html, Oct 24 2026): Tabler outline sprite (src/b/icons/tabler.svg, MIT), same inlining.
  const tabler = () => readFileSync(new URL('./src/b/icons/tabler.svg', import.meta.url), 'utf8').trim()
    .replace(/^<svg\b[^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" id="tb-sprite">');
  return {
    name: 'ari-inline-sprite',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('<!-- ari:sprite -->', svg).replace('<!-- ari:tabler -->', tabler) },
  };
}

export default defineConfig({
  plugins: [react(), inlineSprite()],
  // No source maps in any build (Vercel audit, Release 1 leftover, v18.17.8): the preview must not publish the source.
  build: {
    target: 'es2022', sourcemap: false,
    // b.html: the B+ shell (Owner's lock, Oct 24 2026), demo data only, beside the current app until the cutover slot.
    rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), b: fileURLToPath(new URL('./b.html', import.meta.url)) } },
  },
  test: { include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'], environment: 'node' },
});

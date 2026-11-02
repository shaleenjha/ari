// kyte-ai / ari-ai entries (Oct 30 2026 rename): both serve main.ts, each under its own slug, both fail closed on the named key.
// deno test --allow-read
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1';

const here = new URL('.', import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, here));

Deno.test('kyte-ai entry serves main.ts as kyte-ai and checks the ari_ai key', () => {
  const s = read('index.ts');
  assertMatch(s, /from '\.\/main\.ts'/);
  assertMatch(s, /serveAi\('kyte-ai', \(\) => secretKey\('ari_ai'\)\)/);
});

Deno.test('ari-ai is only a legacy alias of kyte-ai', () => {
  const s = read('../ari-ai/index.ts');
  assertMatch(s, /from '\.\.\/kyte-ai\/main\.ts'/);
  assertMatch(s, /serveAi\('ari-ai', \(\) => secretKey\('ari_ai'\)\)/);
  const code = s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  assertEquals(code.length, 3, 'two imports and one call, nothing else');
  assertEquals([...Deno.readDirSync(new URL('../ari-ai/', here))].map((e) => e.name), ['index.ts']);
});

Deno.test('main.ts kicks its own slug, never a fixed one', () => {
  const s = read('main.ts');
  assert(s.includes('/functions/v1/${slug}'));
  assert(!/functions\/v1\/(ari|kyte)-ai/.test(s));
});

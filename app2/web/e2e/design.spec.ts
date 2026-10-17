import { expect, test } from '@playwright/test';
import { MIN_TAP, checkText, isSystemFamily, firstFamily, requiredRatio, contrast } from '../scripts/design-lint/rules.mjs';
import { SCREENS, open } from './screens';

// Design lint, rendered half (rules 1 to 5). Runs in every project (360, 390 and 412 px, Chromium and WebKit), synthetic data only.
// Hit targets, dead taps and Today height are in e2e/mobile.spec.ts. `npm run lint:design` runs both; `npm run e2e` skips them (@design tag).

for (const s of SCREENS) {
  test(`@design ${s.name}: tap targets ≥ ${MIN_TAP}px`, async ({ page }) => {
    await open(page, s);
    const small = await page.evaluate((min) => {
      const sel = 'button, a[href], [role=button], input:not([type=hidden]), select, textarea, summary';
      return [...document.querySelectorAll<HTMLElement>(sel)].flatMap((el) => {
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') return [];
        if (r.width + 0.5 < min || r.height + 0.5 < min) return [`${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${r.width.toFixed(1)}x${r.height.toFixed(1)}`];
        return [];
      });
    }, MIN_TAP);
    expect(small, 'interactive elements below the minimum tap size').toEqual([]);
  });

  test(`@design ${s.name}: text contrast`, async ({ page }) => {
    await open(page, s);
    const samples = await page.evaluate(() => {
      const parse = (c: string): [number, number, number, number] => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return [0, 0, 0, 0];
        const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
        return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
      };
      const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
      const bgOf = (el: Element): number[] => {
        const chain: number[][] = [];
        for (let e: Element | null = el; e; e = e.parentElement) {
          const c = parse(getComputedStyle(e).backgroundColor);
          if (c[3]! > 0) { chain.push(c); if (c[3] === 1) break; }
        }
        let base = [255, 255, 255];
        const root = parse(getComputedStyle(document.documentElement).backgroundColor);
        if (root[3]! > 0) base = over(root, base);
        for (const c of chain.reverse()) base = over(c, base);
        return base;
      };
      const out: { text: string; fg: number[]; bg: number[]; px: number; weight: number }[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set<Element>();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || seen.has(el) || !n.textContent?.trim()) continue;
        seen.add(el);
        if (el.closest('button:disabled, [aria-disabled=true], script, style, noscript')) continue;
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') continue;
        let op = 1; for (let e: Element | null = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
        const bg = bgOf(el);
        const fg = parse(cs.color); fg[3] = fg[3]! * op;
        out.push({ text: n.textContent.trim().slice(0, 40), fg: over(fg, bg), bg, px: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400 });
      }
      return out;
    });
    expect(samples.length).toBeGreaterThan(0);
    const fails = samples
      .map((x) => ({ ...x, ratio: contrast(x.fg as [number, number, number], x.bg as [number, number, number]), need: requiredRatio(x.px, x.weight) }))
      .filter((x) => x.ratio + 1e-9 < x.need)
      .map((x) => `"${x.text}" ${x.ratio.toFixed(2)}:1 < ${x.need}:1 (${x.px}px/${x.weight})`);
    expect(fails, 'text below WCAG AA contrast').toEqual([]);
  });

  test(`@design ${s.name}: copy has no banned strings`, async ({ page }) => {
    await open(page, s);
    const texts = await page.evaluate(() => [
      document.title,
      ...document.body.innerText.split('\n'),
      ...[...document.querySelectorAll('[aria-label],[title],[placeholder],[alt]')].flatMap((e) => ['aria-label', 'title', 'placeholder', 'alt'].map((a) => e.getAttribute(a) ?? '')),
    ].filter((t) => t.trim()));
    const bad = texts.flatMap((t) => checkText(t, { copy: true }).map((v) => `${v.rule} "${v.match}" in: ${t.slice(0, 60)}`));
    expect(bad, 'banned strings in rendered copy').toEqual([]);
  });
}

test('@design primary font is not a system stack, and it loaded', async ({ page }) => {
  await open(page, SCREENS[0]!);
  const r = await page.evaluate(() => {
    const fams = [document.body, document.querySelector('h1'), document.querySelector('button')].filter(Boolean).map((e) => getComputedStyle(e!).fontFamily);
    const first = (fams[0] ?? '').split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
    return { fams, first, loaded: document.fonts.check(`16px "${first}"`) && [...document.fonts].some((f) => f.family.replace(/['"]/g, '') === first && f.status === 'loaded') };
  });
  for (const f of r.fams) expect(isSystemFamily(firstFamily(f)), `primary font ${f}`).toBe(false);
  expect(r.loaded, `${r.first} loaded`).toBe(true);
});

test('@design no gradients or glow shadows rendered', async ({ page }) => {
  for (const s of SCREENS.filter((x) => !x.name.includes(','))) {
    await open(page, s);
    const bad = await page.evaluate(() => [...document.querySelectorAll('*')].flatMap((e) => {
      const cs = getComputedStyle(e);
      const out: string[] = [];
      if (/gradient\(/.test(cs.backgroundImage)) out.push(`${e.tagName} gradient`);
      for (const sh of [cs.boxShadow, cs.textShadow]) {
        if (sh && sh !== 'none' && sh.split(/,(?![^(]*\))/).some((p) => Number((p.replace(/rgba?\([^)]*\)/g, '').match(/-?[\d.]+px/g) ?? [])[2]?.replace('px', '') ?? 0) > 0)) out.push(`${e.tagName} glow ${sh}`);
      }
      return out;
    }));
    expect(bad, `${s.name}: gradients or glows`).toEqual([]);
  }
});

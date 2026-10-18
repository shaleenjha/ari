import { expect, test } from '@playwright/test';
import { CONTRAST_EXEMPT, MIN_TAP, STATUS_SEL, checkText, colorOnlyStatus, isSystemFamily, firstFamily, requiredRatio, contrast } from '../scripts/design-lint/rules.mjs';
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
    const samples = await page.evaluate((exempt) => {
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
        if (el.closest(`${exempt}, script, style, noscript`)) continue;   // inactive controls only (rules.mjs CONTRAST_EXEMPT)
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') continue;
        let op = 1; for (let e: Element | null = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
        const bg = bgOf(el);
        const fg = parse(cs.color); fg[3] = fg[3]! * op;
        out.push({ text: n.textContent.trim().slice(0, 40), fg: over(fg, bg), bg, px: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400 });
      }
      return out;
    }, CONTRAST_EXEMPT);
    expect(samples.length).toBeGreaterThan(0);
    const fails = samples
      .map((x) => ({ ...x, ratio: contrast(x.fg as [number, number, number], x.bg as [number, number, number]), need: requiredRatio(x.px, x.weight) }))
      .filter((x) => x.ratio + 1e-9 < x.need)
      .map((x) => `"${x.text}" ${x.ratio.toFixed(2)}:1 < ${x.need}:1 (${x.px}px/${x.weight})`);
    expect(fails, 'text below WCAG AA contrast').toEqual([]);
  });

  test(`@design ${s.name}: status never rests on colour alone`, async ({ page }) => {
    await open(page, s);
    const items = await page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(sel)].flatMap((el) => {
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden') return [];
      return [{ label: `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').join('.') : ''}`, text: el.textContent ?? '', w: r.width, h: r.height }];
    }), STATUS_SEL);
    expect(colorOnlyStatus(items), 'status elements with no text or glyph').toEqual([]);
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

test('@design no gradients, glow shadows or backdrop blur rendered', async ({ page }) => {
  for (const s of SCREENS.filter((x) => !x.name.includes(','))) {
    await open(page, s);
    const bad = await page.evaluate(() => [...document.querySelectorAll('*')].flatMap((e) => {
      const cs = getComputedStyle(e);
      const out: string[] = [];
      if (/gradient\(/.test(cs.backgroundImage)) out.push(`${e.tagName} gradient`);
      const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || 'none';
      if (bf !== 'none') out.push(`${e.tagName} backdrop-filter ${bf}`);
      for (const sh of [cs.boxShadow, cs.textShadow]) {
        if (sh && sh !== 'none' && sh.split(/,(?![^(]*\))/).some((p) => Number((p.replace(/rgba?\([^)]*\)/g, '').match(/-?[\d.]+px/g) ?? [])[2]?.replace('px', '') ?? 0) > 0)) out.push(`${e.tagName} glow ${sh}`);
      }
      return out;
    }));
    expect(bad, `${s.name}: gradients or glows`).toEqual([]);
  }
});

// Citrine s2/tokens (v18.16.0): type is rem-based, so it follows the root size the phone sets (meta text-scale on
// Android Chrome and Brave, Dynamic Type on iOS). Raising the root by 25% must raise every piece of text by 25%.
test('@design text follows the phone text size (rem type)', async ({ page }) => {
  for (const s of [SCREENS[0]!, SCREENS.find((x) => x.name === 'Report')!]) {
    await open(page, s);
    const sizes = () => page.evaluate(() => {
      const out: Record<string, number> = {};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let i = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || !n.textContent?.trim() || el.closest('script, style, noscript, .sr-only')) continue;
        out[`${i++}:${n.textContent.trim().slice(0, 24)}`] = parseFloat(getComputedStyle(el).fontSize);
      }
      return out;
    });
    const before = await sizes();
    await page.evaluate(() => { const r = document.documentElement; r.style.fontSize = `${parseFloat(getComputedStyle(r).fontSize) * 1.25}px`; });
    const after = await sizes();
    const fixed = Object.keys(before).filter((k) => after[k] !== undefined && Math.abs(after[k]! / before[k]! - 1.25) > 0.01)
      .map((k) => `"${k}" ${before[k]}px -> ${after[k]}px`);
    expect(fixed, `${s.name}: text that ignores the phone text size`).toEqual([]);
  }
});

test('@design reduced motion: every move is a 120 ms fade with no travel; the tab bar is solid with no blur', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, SCREENS[0]!);
  const r = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const tabs = getComputedStyle(document.querySelector('.tabs')!);
    const probe = document.createElement('i'); document.body.append(probe);
    const durs = ['--dur-release', '--dur-tab', '--dur-sheet-open', '--dur-exit', '--dur-toast-in', '--dur-card-in', '--dur-check'].map((k) => {
      probe.style.transitionDuration = `var(${k})`; return getComputedStyle(probe).transitionDuration;
    });
    probe.remove();
    return { durs, move: root.getPropertyValue('--move').trim(), bg: tabs.backgroundColor, blur: tabs.backdropFilter || 'none' };
  });
  expect(r.durs).toEqual(Array(7).fill('0.12s'));
  expect(r.move).toBe('0');
  expect(r.blur).toBe('none');
  expect(r.bg).toMatch(/^rgba?\(18, 18, 18/);
});

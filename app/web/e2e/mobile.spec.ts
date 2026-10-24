import { expect, test, type Page } from '@playwright/test';
import { MIN_TAP, TODAY_MAX_VIEWPORTS } from '../scripts/design-lint/rules.mjs';
import { SCREENS, open } from './screens';

// Headless mobile harness (spec 02 §2). Runs in every project: 360, 390 and 412 px, Chromium and WebKit, touch on.
// Hit target: each visible, enabled SEL element is at least MIN_TAP on both sides, has pointer-events, and is what
// elementFromPoint finds at its centre. Dead tap: a tap must change something within 400 ms (a DOM mutation other than
// style/class on the tapped element, a URL change, a focus change, or a React handler call). Opt-out on the element or
// an ancestor: data-lint-allow="dead-tap <reason>". A button focusing itself on tap is not a focus change (Chromium
// focuses every tapped button, which would make every button look live).

const SEL = 'button, a[href], [role=button], [role=link], [role=tab], [role=switch], input:not([type=hidden]), select, textarea, summary, label[for], [onclick], [tabindex]:not([tabindex="-1"])';

const targets = (page: Page) => page.evaluate((sel) => {
  const out = [...document.querySelectorAll<HTMLElement>(sel)].flatMap((el, i) => {
    let r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || el.matches(':disabled')) return [];   // aria-disabled stays in: 48px and live tap still apply
    el.dataset.tapIdx = String(i);
    // elementFromPoint only sees the viewport: bring the target to the middle of the screen first, as a person would
    // scroll to it. Anything still on top of it there (a fixed bar, an overlay) is a real cover.
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return [{ i, label: (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 30), w: r.width, h: r.height,
      pe: cs.pointerEvents, covered: !(hit && el.contains(hit)), ariaDisabled: el.getAttribute('aria-disabled') === 'true', allow: el.closest('[data-lint-allow^="dead-tap "]') !== null }];
  });
  scrollTo({ top: 0, left: 0, behavior: 'instant' });
  return out;
}, SEL);

for (const s of SCREENS) {
  test(`@design ${s.name}: hit targets`, async ({ page }) => {
    await open(page, s);
    const bad = (await targets(page)).filter((t) => t.w + 0.5 < MIN_TAP || t.h + 0.5 < MIN_TAP || t.pe === 'none' || t.covered)
      .map((t) => `"${t.label}" ${t.w | 0}x${t.h | 0} ${t.pe}${t.covered ? ' covered' : ''}`);
    expect(bad, 'hit targets').toEqual([]);
  });

  test(`@design ${s.name}: no dead taps`, async ({ page }) => {
    test.setTimeout(150_000); // up to 60 taps, each 400 ms plus a fresh reopen of the screen
    await open(page, s);
    const dead: string[] = []; const all = (await targets(page)).filter((t) => !t.allow);
    expect(all.length, 'dead-tap-budget').toBeLessThanOrEqual(60);
    for (const t of all) {
      const loc = page.locator(`[data-tap-idx="${t.i}"]`);
      await loc.evaluate((el) => {
        const w = window as any; w.__el = el; w.__tap = 0; w.__mut = 0; w.__href = location.href; w.__focus = document.activeElement;
        new MutationObserver((rs) => { if (rs.some((r) => !(r.target === el && r.type === 'attributes' && /^(style|class|data-tap-idx)$/.test(r.attributeName!)))) w.__mut = 1; })
          .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        for (let n: any = el; n; n = n.parentElement) {
          const k = Object.keys(n).find((x) => x.startsWith('__reactProps$')); if (!k) continue;
          for (const h of ['onClick', 'onPointerUp', 'onPointerDown', 'onTouchEnd', 'onChange']) {
            const f = n[k][h]; if (f) n[k][h] = (...a: unknown[]) => { w.__tap = 1; return f(...a); };
          }
        }
      });
      // Playwright refuses to tap aria-disabled controls; a person can, and the tap must still answer (the read-only toast).
      if (t.ariaDisabled) await loc.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));   // clear of the tab bar
      await loc.tap(t.ariaDisabled ? { force: true } : undefined);
      await page.waitForTimeout(400);
      const live = await page.evaluate(() => { const w = window as any; const a = document.activeElement; const el: Element | undefined = w.__el;
        // Chromium focuses any button it taps, so a button taking focus from its own tap is not a change. Focus moving
        // elsewhere counts, and so does a text field, select or editable taking focus (that opens the keyboard or picker).
        const selfFocus = !!el && a === el && !el.matches('input, textarea, select, [contenteditable=""], [contenteditable=true]');
        return !!(w.__tap || w.__mut || location.href !== w.__href || (a !== w.__focus && !selfFocus)); });
      if (!live) dead.push(t.label); else { await open(page, s); await targets(page); }
    }
    expect(dead, 'taps that change nothing').toEqual([]);
  });
}

test('@design Today height ≤ 1.5 viewports', async ({ page }) => {
  await open(page, SCREENS[0]!);
  const { h, vh } = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, vh: innerHeight }));
  expect(h, `Today ${h}px at ${vh}px`).toBeLessThanOrEqual(vh * TODAY_MAX_VIEWPORTS);
});

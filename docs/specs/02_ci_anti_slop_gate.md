# 02 CI anti-slop gate

## 1. Static copy lint (`scripts/design-lint/rules.mjs`)

```js
// all literals: dash, buzzword. copy only: exclamation, place-or-timezone (TZ, CITY), infra-word.
const BANG = /!/;
const DASH = /[\u2012-\u2015]/; // U+2013, U+2014, figure dash, bar
const BUZZ = /\b(seamless(?:ly)?|empower(?:s|ed|ing|ment)?|unlock(?:s|ed|ing)?|supercharg(?:e|es|ed|ing)|leverag(?:e|es|ed|ing)|elevat(?:e|es|ed|ing)|game[- ]?chang(?:er|ers|ing)|revolutioni[sz](?:e|es|ed|ing)|effortless(?:ly)?|delight(?:s|ed|ful|fully|ing)?|cutting[- ]edge|robust(?:ly|ness)?|world[- ]class)\b/i;
const TZ = /\b(?:IST|PST|PDT|PT|ET|EST|EDT|CET|GMT|UTC)\b|\b(?:UTC|GMT)\s?[+\u2212-]\d{1,2}(?::?\d{2})?|(?<![\d:])[+\u2212-](?:0\d|1[0-4]):[0-5]\d\b/;
const CITY = /\b(?:bengaluru|bangalore|india|mumbai|delhi|kolkata|san francisco|new york|london|(?:asia|america|europe)\/[a-z_]+)\b/i;
const INFRA = /\b(?:supabase|vercel|postgres(?:ql)?|postgrest|rls|databases?|apis?|tokens?|workers?|cron(?:s|job|jobs)?)\b/i;
```

**Finding copy** (`static.mjs`, TypeScript compiler API, TSX):
- Copy: non-blank `JsxText`; in `.tsx`, `StringLiteral`/template text unless `isCodeLiteral` (import/export, equality operand, `case`, element-access key, property name, literal type, or a `NON_COPY_ATTRS` attribute value such as `className`, `href`). Operator `!` is never a literal; regex literals are skipped.
- Also copy: `index.html` text and `title|alt|aria-label|placeholder|content`, manifest `name|short_name|description`. Scope `src/**/*.{ts,tsx}` minus tests and `.d.ts`.

**Allow mechanics**
- `scripts/design-lint/allow.json`: `{ "<path>": ["<rule>"] }` turns rules off per file.
- Inline `// lint-allow: <rule> <reason>` (JSX: `{/* lint-allow: ... */}`) on the same line or the line above suppresses only `<rule>`. Missing reason or unknown rule: `lint-allow-invalid` (error). Legacy `design-lint-allow:` is rejected. An allow that suppresses nothing: `lint-allow-stale` (warning).

**Output** (exit 1 on any error; `CI=true` adds annotations):

```
src/today/Card.tsx:42:13  exclamation  "!"  in: You're all set!
::error file=app2/web/src/today/Card.tsx,line=42,col=13,title=exclamation::"!" in UI copy
```

## 2. Headless mobile harness

`playwright.config.ts`:

```ts
const sizes = [
  { name: '360', use: { viewport: { width: 360, height: 780 } } },
  { name: '390', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 } },
  { name: '412', use: { viewport: { width: 412, height: 915 } } },
];
// project use: { ...e.use, ...s.use, isMobile: true, hasTouch: true, browserName }
```

New `e2e/mobile.spec.ts` (`@design`; `SCREENS`/`open` move to `e2e/screens.ts`).

**Hit target**: each visible, enabled `SEL` element needs both sides at least 48, `pointer-events` not `none`, and `elementFromPoint` at its centre inside it.

**Dead tap**: live if within 400 ms: a DOM mutation (not `style`/`class` on the tapped element), URL change, focus change, or handler call (React `__reactProps$*` handlers on element and ancestors, wrapped in place). Opt-out: `data-lint-allow="dead-tap <reason>"`.

```ts
import { expect, test, type Page } from '@playwright/test';
import { MIN_TAP, TODAY_MAX_VIEWPORTS } from '../scripts/design-lint/rules.mjs';
import { SCREENS, open } from './screens';

const SEL = 'button, a[href], [role=button], [role=link], [role=tab], [role=switch], input:not([type=hidden]), select, textarea, summary, label[for], [onclick], [tabindex]:not([tabindex="-1"])';

const targets = (page: Page) => page.evaluate((sel) =>
  [...document.querySelectorAll<HTMLElement>(sel)].flatMap((el, i) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || el.matches(':disabled,[aria-disabled=true]')) return [];
    el.dataset.tapIdx = String(i);
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return [{ i, label: (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30), w: r.width, h: r.height,
      pe: cs.pointerEvents, covered: !(hit && el.contains(hit)), allow: el.closest('[data-lint-allow^="dead-tap "]') !== null }];
  }), SEL);

for (const s of SCREENS) {
  test(`@design ${s.name}: hit targets`, async ({ page }) => {
    await open(page, s);
    const bad = (await targets(page)).filter((t) => t.w + 0.5 < MIN_TAP || t.h + 0.5 < MIN_TAP || t.pe === 'none' || t.covered)
      .map((t) => `"${t.label}" ${t.w | 0}x${t.h | 0} ${t.pe}${t.covered ? ' covered' : ''}`);
    expect(bad, 'hit targets').toEqual([]);
  });

  test(`@design ${s.name}: no dead taps`, async ({ page }) => {
    await open(page, s);
    const dead: string[] = []; const all = (await targets(page)).filter((t) => !t.allow);
    expect(all.length, 'dead-tap-budget').toBeLessThanOrEqual(60);
    for (const t of all) {
      const loc = page.locator(`[data-tap-idx="${t.i}"]`);
      await loc.evaluate((el) => {
        const w = window as any; w.__tap = 0; w.__mut = 0; w.__href = location.href; w.__focus = document.activeElement;
        new MutationObserver((rs) => { if (rs.some((r) => !(r.target === el && r.type === 'attributes' && /^(style|class|data-tap-idx)$/.test(r.attributeName!)))) w.__mut = 1; })
          .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        for (let n: any = el; n; n = n.parentElement) {
          const k = Object.keys(n).find((x) => x.startsWith('__reactProps$')); if (!k) continue;
          for (const h of ['onClick', 'onPointerUp', 'onPointerDown', 'onTouchEnd', 'onChange']) {
            const f = n[k][h]; if (f) n[k][h] = (...a: unknown[]) => { w.__tap = 1; return f(...a); };
          }
        }
      });
      await loc.tap();
      await page.waitForTimeout(400);
      const live = await page.evaluate(() => { const w = window as any;
        return !!(w.__tap || w.__mut || location.href !== w.__href || document.activeElement !== w.__focus); });
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
```

Replaces the 412x915 Today test in `design.spec.ts`.

## 3. Query safety lint (`scripts/query-lint/query-lint.mjs`)

`query-unbounded`: `.from(..)` then `.select(..)` needs `.limit|.range|.single|.maybeSingle` on the same chain or variable. Exempt: `{ head: true }`, and `insert|upsert|update|delete` before `select`..

```js
import ts from 'typescript';
const TERM = new Set(['limit', 'range', 'single', 'maybeSingle']);
const MUT = new Set(['insert', 'upsert', 'update', 'delete']);

function outward(node) {
  const names = []; let n = node;
  while (ts.isPropertyAccessExpression(n.parent) && ts.isCallExpression(n.parent.parent)) { names.push(n.parent.name.text); n = n.parent.parent; }
  return { names, top: n };
}

export function lintQueries(program) {
  const checker = program.getTypeChecker(); const out = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || /node_modules|\.test\./.test(sf.fileName)) continue;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'from') {
        const { names, top } = outward(node);
        const sel = names.indexOf('select');
        if (sel >= 0 && !names.slice(0, sel).some((m) => MUT.has(m)) && !names.some((m) => TERM.has(m)) && !/head:\s*true/.test(top.getText()) && !viaVariable(top, checker)) {
          if (!allowed(sf, node, 'query-unbounded')) out.push(finding(sf, node, `.from().select() without ${[...TERM].join('/')}`));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
// A terminator on the variable counts only outside if/?:/loops/closures.
function viaVariable(top, checker) {
  let p = top.parent; while (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p)) p = p.parent;
  const decl = ts.isVariableDeclaration(p) ? p : null;
  if (!decl || !ts.isIdentifier(decl.name)) return false;
  const sym = checker.getSymbolAtLocation(decl.name);
  const block = decl.parent.parent.parent;
  let ok = false;
  const scan = (n) => {
    if (ts.isIdentifier(n) && n !== decl.name && checker.getSymbolAtLocation(n) === sym) {
      const { names } = outward(n);
      let cond = false;
      for (let s = n.parent; s !== block; s = s.parent)
        if (ts.isIfStatement(s) || ts.isConditionalExpression(s) || ts.isIterationStatement(s, false) || ts.isFunctionLike(s)) cond = true;
      if (!cond && names.some((m) => TERM.has(m))) ok = true;
    }
    ts.forEachChild(n, scan);
  };
  scan(block);
  return ok;
}
```

`allowed`/`finding` reuse §1. Programs: `app2/web` and `app2/jobs` tsconfigs. `query-lint.test.ts` (vitest): `fixtures/fail.ts` reports exactly its `// expect` lines, `fixtures/pass.ts` nothing.

```ts
// pass.ts
await sb.from('people').select('id,name').limit(50);
await sb.from('people').select('*').eq('id', id).single();
await sb.from('tasks').select('*', { count: 'exact', head: true });
let q = sb.from('replies').select('*').order('at');
q = q.range(0, 24);
const r = sb.from('accounts').select('*'); await r.maybeSingle();
// fail.ts
await sb.from('people').select('*'); // expect: query-unbounded
const q2 = sb.from('replies').select('*'); // expect: query-unbounded
if (small) q2.limit(5);
await q2;
const q3 = sb.from('tasks').select('id'); return q3; // expect: query-unbounded
```

## 4. CI wiring (`.github/workflows/ci.yml`)

app2/web scripts: `"lint:query": "node scripts/query-lint/query-lint.mjs"`, `"lint:slop": "npm run lint:design:static && npm run lint:query"`.

| job | needs | command | budget |
|---|---|---|---|
| `anti-slop-static` | none | `npm ci && npm run lint:slop` | 2 min, `timeout-minutes: 3` |
| `design-lint` (360/390/412, Chromium and WebKit) | `web`, `anti-slop-static` | `npm run lint:design` | 8 min, `timeout-minutes: 10` |

- Blocking, both required: every rule in §1 to §3, `lint-allow-invalid`, `dead-tap-budget`.
- Warning (`::warning`, exit 0): `lint-allow-stale`, `allow.json` paths that no longer exist.
- `design-lint`: `retries: 1`, failure artifacts.

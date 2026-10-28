import { describe, expect, it } from 'vitest';
import { CONTRAST_EXEMPT, TOKENS_FILE, checkText, forbiddenPairs, colorDrift, colorOnlyStatus, contrast, contrastExempt, isGlow, lintCss, parseColor, requiredRatio, tokenContrast } from './rules.mjs';
import { lintCssFile, lintSource, lintTokens } from './static.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInlineAllows } from './allow.mjs';

const rules = (t: string, copy = true) => checkText(t, { copy }).map((h) => h.rule);

describe('design lint rules', () => {
  it('banned strings in copy', () => {
    expect(rules('Done!')).toEqual(['exclamation']);
    expect(rules('Fast \u2014 really')).toContain('dash');
    expect(rules('Pages 1\u20132')).toContain('dash');
    for (const w of ['seamlessly', 'Empowering teams', 'unlock', 'Supercharge', 'leverage', 'elevate', 'game-changer', 'revolutionize', 'effortless', 'delightful']) expect(rules(w)).toContain('buzzword');
    for (const w of ['cutting-edge', 'robust', 'world class']) expect(rules(w)).toContain('buzzword');
    for (const w of ['9 AM IST', 'at 5 PT', '10 ET', '3 PM CET', 'UTC+5:30', 'GMT -8', 'at 09:00 +05:30', 'Bengaluru', 'bangalore office', 'New York', 'Asia/Kolkata', 'India']) expect(rules(w)).toContain('place-or-timezone');
    for (const w of ['Supabase', 'on Vercel', 'the database', 'API error', 'token expired', 'worker down', 'cron', 'Postgres', 'PostgREST', 'RLS']) expect(rules(w)).toContain('infra-word');
    expect(rules('9:30 to 10:15')).toEqual([]);
    expect(rules('3 of 15, girls and boys')).toEqual([]);
    expect(rules('Mark sent')).toEqual([]);
    expect(rules('Tidy up · 3 to check')).toEqual([]);
    expect(rules('Its elevation was set')).toEqual([]);
    expect(rules('Ready now, list it')).toEqual([]);
  });
  it('non-copy literals only fail on dashes and buzzwords', () => {
    expect(rules('/rest/v1/token?x=1', false)).toEqual([]);
    expect(rules('worker', false)).toEqual([]);
    expect(rules('a\u2014b', false)).toEqual(['dash']);
  });
  it('tsx: JSX text and copy literals are copy, classNames and comparisons are not', () => {
    const src = `export const A = (x: string) => <div className="worker"><b>Hi!</b>{x === 'cron' ? 'a' : 'Saved to database'}<i aria-label="API key" /></div>;`;
    const f = lintSource('x.tsx', src).map((h) => `${h.rule}:${h.match}`);
    expect(f).toEqual(['exclamation:!', 'infra-word:database', 'infra-word:API']);
    expect(lintSource('x.ts', `const s = 'Hi! token';`)).toEqual([]);
  });
  it('finding positions point at the match, also in multi-line JSX text', () => {
    const f = lintSource('x.tsx', `export const A = () => (\n  <p>\n    You are all set!\n  </p>\n);`);
    expect(f.map((h) => `${h.rule}@${h.line}:${h.col}`)).toEqual(['exclamation@3:20']);
  });
  it('allows: inline per rule, with a reason; legacy, unknown and reasonless allows are invalid; unused is stale', () => {
    const rs = (src: string, file = 'x.tsx') => lintSource(file, src).map((h) => `${h.severity}:${h.rule}@${h.line}`);
    expect(rs(`// lint-allow: exclamation brand name has a bang\nconst s = <b>Yahoo!</b>;`)).toEqual([]);
    expect(rs(`const s = <b>Yahoo!</b>; // lint-allow: exclamation brand name`)).toEqual([]);
    expect(rs(`const s = <b>{/* lint-allow: exclamation brand name */}Yahoo!</b>;`)).toEqual([]);
    // suppresses only the named rule
    expect(rs(`// lint-allow: exclamation brand\nconst s = <b>Yahoo! API</b>;`)).toEqual(['error:infra-word@2']);
    // two lines below is out of reach, and the allow is then stale
    expect(rs(`// lint-allow: exclamation brand\n\nconst s = <b>Hi!</b>;`)).toEqual(['error:exclamation@3', 'warning:lint-allow-stale@1']);
    expect(rs(`// design-lint-allow: test\nconst s = 'Hi!';`)).toEqual(['error:exclamation@2', 'error:lint-allow-invalid@1']);
    expect(rs(`// lint-allow: exclamation\nconst s = 'Hi!';`)).toEqual(['error:exclamation@2', 'error:lint-allow-invalid@1']);
    expect(rs(`// lint-allow: shouting because\nconst s = 'Hi!';`)).toEqual(['error:exclamation@2', 'error:lint-allow-invalid@1']);
    // an allow for another lint's rule is never stale here
    expect(rs(`// lint-allow: query-unbounded tiny table\nconst s = 1;`, 'x.ts')).toEqual([]);
    expect(parseInlineAllows(`/* lint-allow: gradient hero art */`)[0]).toMatchObject({ rule: 'gradient', reason: 'hero art', problem: null });
    expect(lintCssFile('a.css', `.x {\n  /* lint-allow: gradient hero art */\n  background: linear-gradient(red, blue);\n}`)).toEqual([]);
  });
  it('file-level allows from allow.json', () => {
    const jsonEntries = new Map([['x.tsx', [{ rule: 'exclamation', reason: 'r', used: false }]]]);
    expect(lintSource('x.tsx', `const s = <b>Hi!</b>;`, { jsonEntries })).toEqual([]);
    expect(jsonEntries.get('x.tsx')![0]!.used).toBe(true);
  });
  it('css: system font as primary, gradients, glows', () => {
    const css = `:root { --font: 'Inter', system-ui, sans-serif; font: 16px/1.4 var(--font); }
      .a { font-family: system-ui, sans-serif; } .b { font: inherit; } .c { background: linear-gradient(red, blue); }
      .d { box-shadow: 0 0 12px #E2B062; } .e { box-shadow: 0 0 0 1px #333; } a:hover { color: red; }`;
    // tokens: true keeps raw-color out of this rule-5 case (its hex literals are covered in the citrine case below)
    expect(lintCss(css, { allowEffects: false, tokens: true }).map((x) => `${x.rule}@${x.line}`)).toEqual(['system-font-primary@2', 'gradient@2', 'glow@3']);
    expect(lintCss(`:root { font: 16px/1.4 -apple-system, 'Inter'; }`, { allowEffects: true, tokens: true }).map((x) => x.rule)).toEqual(['system-font-primary']);
    expect(lintCss(`.c { background: radial-gradient(red, blue); box-shadow: 0 4px 20px rgba(0,0,0,.4) }`, { allowEffects: true, tokens: true })).toEqual([]);
    expect(isGlow('none')).toBe(false);
    expect(isGlow('inset 0 -1px 0 rgba(255, 255, 255, 0.1)')).toBe(false);
  });
  it('contrast maths matches WCAG', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([118, 118, 118], [255, 255, 255])).toBeGreaterThan(4.5);
    expect(requiredRatio(16, 400)).toBe(4.5);
    expect(requiredRatio(18.66, 700)).toBe(3);
    expect(requiredRatio(18.66, 400)).toBe(4.5);
    expect(requiredRatio(24, 400)).toBe(3);
  });
  it('contrast: only aria-disabled controls are exempt, the thresholds do not move', () => {
    expect(CONTRAST_EXEMPT).toBe('[aria-disabled="true"]');
    expect(contrastExempt({ 'aria-disabled': 'true' })).toBe(true);
    expect(contrastExempt({ disabled: '' })).toBe(false);
    expect(contrastExempt({ 'aria-disabled': 'false' })).toBe(false);
    expect(requiredRatio(16, 400)).toBe(4.5);
    expect(requiredRatio(24, 400)).toBe(3);
  });
  it('citrine: raw colours only in the token file, backdrop-filter nowhere', () => {
    const css = `.a { color: #fff; }\n.b { background: rgba(0, 0, 0, .5); }\n.c { color: var(--text-primary); border-color: color-mix(in srgb, var(--accent), transparent); }\n.d { -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }\n.e { backdrop-filter: none; }`;
    expect(lintCss(css, { allowEffects: false }).map((x) => `${x.rule}@${x.line}`)).toEqual(['raw-color@1', 'raw-color@2', 'backdrop-filter@4', 'backdrop-filter@4']);
    expect(lintCss(css, { allowEffects: true, tokens: true }).map((x) => x.rule)).toEqual(['backdrop-filter', 'backdrop-filter']);
    expect(lintCssFile(TOKENS_FILE, `:root { --s-canvas: #121212; }`)).toEqual([]);
    expect(lintCssFile('src/ui/styles.css', `:root { --bg: #121212; }`).map((x) => x.rule)).toEqual(['raw-color']);
    const inline = lintSource('x.tsx', `export const A = () => <div style={{ color: '#E5D0AC', backdropFilter: 'blur(4px)' }} />;`).map((h) => h.rule);
    expect(inline).toEqual(expect.arrayContaining(['raw-color', 'backdrop-filter']));
    // a hash route is not a colour
    expect(lintSource('x.tsx', `export const A = () => <a href="#/add" style={{ width: '3ch' }}>Add</a>;`)).toEqual([]);
  });
  it('citrine: font stacks resolve through token variables', () => {
    const vars = new Map([['--font-sans', 'system-ui, sans-serif']]);
    expect(lintCss(`body { font-family: var(--font-sans); }`, { allowEffects: false, vars }).map((x) => x.rule)).toEqual(['system-font-primary']);
  });
  it('citrine: colour parsing', () => {
    expect(parseColor('#121212')).toEqual([18, 18, 18, 1]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('rgba(18, 18, 18, 0.96)')).toEqual([18, 18, 18, 0.96]);
    expect(parseColor('var(--x)')).toBeNull();
  });
  it('S2: token contrast matrix', () => {
    const ok = tokenContrast(`:root { --canvas: #121212; --surface-3: #2E2C29; --text-1: #ECE6DC; --text-3: #979289; --accent: #F0AA3C; --on-accent: #121212; --hairline: #34322E; --s-2: 8px; }`);
    expect(ok.findings).toEqual([]);
    // 3 text tokens x 2 surfaces, minus text-3 on surface-3, plus ink on the key and on text-1; hairline and spacing are not pairs
    expect(ok.pairs).toHaveLength(3 * 2 - 1 + 2);
    expect(ok.pairs.some((p) => p.text === '--text-3' && p.surface === '--surface-3')).toBe(false);
    // --s-N is spacing now, never a surface
    expect(ok.pairs.some((p) => p.surface === '--s-2')).toBe(false);
    const bad = tokenContrast(`:root { --canvas: #121212; --surface-2: #252421; --text-1: #ECE6DC; --text-3: #8A857C; }`);
    expect(bad.findings.map((f) => f.match)).toEqual(['--text-3 on --surface-2 is 4.23:1 < 4.5:1']);
    expect(tokenContrast(`:root { --canvas: #121212; }`).findings.map((f) => f.match)).toEqual(['--text-1 missing']);
    // boundaries need 3:1 (WCAG 1.4.11)
    const line = tokenContrast(`:root { --canvas: #121212; --text-1: #ECE6DC; --border: #34322E; }`);
    expect(line.findings.some((f) => f.match.startsWith('--border on --canvas') && f.match.endsWith('< 3:1'))).toBe(true);
  });
  it('S2: text-3 on surface-3 is banned in stylesheets; px font sizes and raw motion only in the token file', () => {
    expect(forbiddenPairs(`.a { color: var(--text-3); background: var(--surface-3); }\n.b { color: var(--text-3); background: var(--surface-1); }`).map((x) => x.line)).toEqual([1]);
    expect(lintCssFile('src/ui/x.css', `.a {\n  background: var(--surface-3); color: var(--text-3);\n}`).map((x) => `${x.rule}@${x.line}`)).toEqual(['token-contrast@1']);
    const css = `.a { font-size: 14px; }\n.b { font: 600 17px/24px var(--font-sans); }\n.c { font-size: var(--fs-meta); line-height: 20px; }\n.d { transition: opacity 200ms ease; }\n.e { transition: color var(--dur-tab) var(--ease-ui); }\n.f { transition-timing-function: cubic-bezier(.2,.8,.3,1); }\n.g { animation: p var(--dur-pulse) ease-in-out infinite; }`;
    expect(lintCss(css, { allowEffects: false }).map((x) => `${x.rule}@${x.line}`)).toEqual(['px-font-size@1', 'px-font-size@2', 'raw-motion@4', 'raw-motion@6']);
    expect(lintCss(css, { allowEffects: false, tokens: true })).toEqual([]);
  });
  it('citrine: the real token file passes, and the mirrors match it', () => {
    const root = join(__dirname, '../..');
    const tokens = readFileSync(join(root, TOKENS_FILE), 'utf8');
    const r = lintTokens(tokens, [['index.html', readFileSync(join(root, 'index.html'), 'utf8')], ['public/manifest.webmanifest', readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8')]]);
    expect(r.findings).toEqual([]);
    expect(r.pairs.every((p) => p.ratio >= p.need)).toBe(true);
    // S2: raw hex is banned in every literal and in src/ SVG, template literals and fill/stroke attributes included
    expect(lintSource('x.tsx', 'export const A = () => <svg><path fill="#F0AA3C" stroke={`#fff`} /></svg>;').map((h) => h.rule)).toEqual(['raw-color', 'raw-color']);
    expect(lintSource('x.ts', 'export const c = `color: ${1 > 0 ? "#121212" : "rgb(1,2,3)"}`;').map((h) => h.rule)).toEqual(['raw-color', 'raw-color']);
    expect(lintSource('x.tsx', 'export const A = () => <a href="#/replies"><use href="#ari-copy" /></a>;')).toEqual([]);
    expect(colorDrift('<meta name="theme-color" content="#050505" /><i style="color:#E2B062">', tokens).map((d) => d.match)).toEqual(['#050505', '#E2B062']);
  });
  it('citrine: status needs text or a glyph', () => {
    expect(colorOnlyStatus([{ label: 'span.dot', text: '', w: 8, h: 8 }, { label: 'p.status', text: '', w: 300, h: 0 }, { label: 'em.tag', text: '✓', w: 20, h: 18 }])).toEqual(['span.dot 8x8 has no text or glyph']);
    expect(lintSource('x.tsx', `export const A = () => <><i role="status" /><span data-status="ok" /><p role="status">Saved</p></>;`).map((h) => h.rule)).toEqual(['color-only-status', 'color-only-status']);
  });
});

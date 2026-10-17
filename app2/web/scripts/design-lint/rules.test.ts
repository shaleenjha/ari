import { describe, expect, it } from 'vitest';
import { checkText, contrast, isGlow, lintCss, requiredRatio } from './rules.mjs';
import { lintCssFile, lintSource } from './static.mjs';
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
    expect(lintCss(css, { allowEffects: false }).map((x) => `${x.rule}@${x.line}`)).toEqual(['system-font-primary@2', 'gradient@2', 'glow@3']);
    expect(lintCss(`:root { font: 16px/1.4 -apple-system, 'Inter'; }`, { allowEffects: true }).map((x) => x.rule)).toEqual(['system-font-primary']);
    expect(lintCss(`.c { background: radial-gradient(red, blue); box-shadow: 0 4px 20px rgba(0,0,0,.4) }`, { allowEffects: true })).toEqual([]);
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
});

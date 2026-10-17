import { describe, expect, it } from 'vitest';
import { checkText, contrast, isGlow, lintCss, requiredRatio } from './rules.mjs';
import { lintSource } from './static.mjs';

const rules = (t: string, copy = true) => checkText(t, { copy }).map((h) => h.rule);

describe('design lint rules', () => {
  it('banned strings in copy', () => {
    expect(rules('Done!')).toEqual(['exclamation']);
    expect(rules('Fast \u2014 really')).toContain('dash');
    expect(rules('Pages 1\u20132')).toContain('dash');
    for (const w of ['seamlessly', 'Empowering teams', 'unlock', 'Supercharge', 'leverage', 'elevate', 'game-changer', 'revolutionize', 'effortless', 'delightful']) expect(rules(w)).toContain('buzzword');
    for (const w of ['9 AM IST', 'at 5 PT', '10 ET', 'Bengaluru', 'bangalore office']) expect(rules(w)).toContain('place-or-timezone');
    for (const w of ['Supabase', 'on Vercel', 'the database', 'API error', 'token expired', 'worker down', 'cron']) expect(rules(w)).toContain('infra-word');
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
    expect(lintSource('x.tsx', `// design-lint-allow: test\nconst s = 'Hi!';`)).toEqual([]);
    expect(lintSource('x.ts', `const s = 'Hi! token';`)).toEqual([]);
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

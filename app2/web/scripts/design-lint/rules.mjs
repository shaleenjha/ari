// Design lint rules: zero-token, deterministic checks that replace LLM review of mechanical things.
// Shared by the static source lint (scripts/design-lint/static.mjs), the query lint (scripts/query-lint) and the
// Playwright checks (e2e/design.spec.ts, e2e/mobile.spec.ts).

/** Smallest tap target, CSS px, both sides. */
export const MIN_TAP = 48;
/** Today at 412x915 may be at most this many phone viewports tall with the synthetic data. */
export const TODAY_MAX_VIEWPORTS = 1.5;
/** Widths every screen is checked at (playwright.config.ts projects). */
export const WIDTHS = [360, 390, 412];

/** Only these CSS files may use gradients or glow shadows (none today). Paths relative to app2/web. */
export const EFFECTS_ALLOW_LIST = ['src/ui/effects.allowed.css'];

// All literals: dash, buzzword. UI copy only: exclamation, place-or-timezone (TZ, CITY), infra-word.
const BANG = /!/;
const DASH = /[\u2012-\u2015]/; // U+2013, U+2014, figure dash, bar
const BUZZ = /\b(seamless(?:ly)?|empower(?:s|ed|ing|ment)?|unlock(?:s|ed|ing)?|supercharg(?:e|es|ed|ing)|leverag(?:e|es|ed|ing)|elevat(?:e|es|ed|ing)|game[- ]?chang(?:er|ers|ing)|revolutioni[sz](?:e|es|ed|ing)|effortless(?:ly)?|delight(?:s|ed|ful|fully|ing)?|cutting[- ]edge|robust(?:ly|ness)?|world[- ]class)\b/i;
// Time zones are case-sensitive abbreviations and offsets; cities are not.
const TZ = /\b(?:IST|PST|PDT|PT|ET|EST|EDT|CET|GMT|UTC)\b|\b(?:UTC|GMT)\s?[+\u2212-]\d{1,2}(?::?\d{2})?|(?<![\d:])[+\u2212-](?:0\d|1[0-4]):[0-5]\d\b/;
const CITY = /\b(?:bengaluru|bangalore|india|mumbai|delhi|kolkata|san francisco|new york|london|(?:asia|america|europe)\/[a-z_]+)\b/i;
const INFRA = /\b(?:supabase|vercel|postgres(?:ql)?|postgrest|rls|databases?|apis?|tokens?|workers?|cron(?:s|job|jobs)?)\b/i;

/** Every rule an allow may name. Static copy and CSS rules, the query rule, and the rendered dead-tap opt-out. */
export const RULES = ['dash', 'buzzword', 'exclamation', 'place-or-timezone', 'infra-word', 'system-font-primary', 'gradient', 'glow', 'query-unbounded', 'dead-tap'];

/**
 * Check one piece of text.
 * @param {string} text
 * @param {{ copy: boolean }} opts copy=true for UI copy (rendered text, JSX text, copy literals); false for any other source literal.
 * @returns {{ rule: string, match: string }[]}
 */
export function checkText(text, { copy }) {
  const out = [];
  const hit = (rule, re) => { const m = text.match(re); if (m) out.push({ rule, match: m[0] }); return !!m; };
  hit('dash', DASH);
  hit('buzzword', BUZZ);
  if (copy) {
    hit('exclamation', BANG);
    if (!hit('place-or-timezone', TZ)) hit('place-or-timezone', CITY);
    hit('infra-word', INFRA);
  }
  return out;
}

// ---------- CSS ----------
const SYSTEM_FAMILIES = new Set([
  'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica', 'helvetica neue', 'arial', 'noto sans',
  'ubuntu', 'cantarell', 'oxygen', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'ui-sans-serif', 'ui-serif',
  'ui-monospace', 'ui-rounded', 'times', 'times new roman', 'courier', 'courier new', 'menlo', 'monaco', 'consolas', 'sf pro text',
  'sf pro display', 'san francisco',
]);
const KEYWORD_VALUES = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar']);

/** First family in a font-family list, lowercased, quotes stripped. */
export function firstFamily(list) {
  return (list.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}
export const isSystemFamily = (f) => SYSTEM_FAMILIES.has(f.toLowerCase());

/** Strip comments; return declarations as { prop, value, line }. Enough for flat CSS; nested at-rules are flattened. */
export function declarations(css) {
  const out = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const re = /([-\w]+)\s*:\s*([^;{}]+?)\s*(?=;|})/g;
  let m;
  while ((m = re.exec(clean))) {
    // skip selectors like a:hover { — they are followed by '{', not ';' or '}'
    const line = clean.slice(0, m.index).split('\n').length;
    out.push({ prop: m[1].toLowerCase(), value: m[2].trim(), line });
  }
  return out;
}

function resolveVars(value, vars, depth = 0) {
  if (depth > 5) return value;
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fb) => resolveVars(vars.get(name) ?? fb ?? '', vars, depth + 1));
}

/** Family list from a `font` shorthand: everything after the size (and optional /line-height). */
export function familyFromShorthand(v) {
  const m = v.match(/(?:^|\s)(?:[\d.]+(?:px|r?em|%|pt|vw|vh|ch|ex)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*[\w.%-]+)?\s+(.+)$/i);
  return m ? m[1] : null;
}

/**
 * Lint one stylesheet for rule 5.
 * @param {string} css
 * @param {{ allowEffects: boolean }} opts
 */
export function lintCss(css, { allowEffects }) {
  const decls = declarations(css);
  const vars = new Map(decls.filter((d) => d.prop.startsWith('--')).map((d) => [d.prop, d.value]));
  const out = [];
  for (const d of decls) {
    let fam = null;
    if (d.prop === 'font-family') fam = d.value;
    else if (d.prop === 'font') {
      const v = resolveVars(d.value, vars);
      if (!KEYWORD_VALUES.has(v.trim().toLowerCase())) fam = familyFromShorthand(v) ?? v;
    }
    if (fam !== null) {
      const f = firstFamily(resolveVars(fam, vars));
      if (!KEYWORD_VALUES.has(f) && isSystemFamily(f)) out.push({ rule: 'system-font-primary', line: d.line, match: `${d.prop}: ${d.value}` });
    }
    if (!allowEffects) {
      if (/(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i.test(d.value)) out.push({ rule: 'gradient', line: d.line, match: `${d.prop}: ${d.value}` });
      if (d.prop === 'box-shadow' || d.prop === 'text-shadow' || d.prop === 'filter' && /drop-shadow/i.test(d.value)) {
        if (isGlow(d.prop === 'filter' ? d.value : resolveVars(d.value, vars))) out.push({ rule: 'glow', line: d.line, match: `${d.prop}: ${d.value}` });
      }
    }
  }
  return out;
}

/** Any shadow with a blur radius above 0 is a glow; hairline 0-blur shadows (borders, focus rings) are allowed. */
export function isGlow(value) {
  const v = value.trim().toLowerCase();
  if (v === 'none' || v === '') return false;
  if (/drop-shadow/.test(v)) return true;
  for (const part of v.split(/,(?![^(]*\))/)) {
    const lens = part.replace(/(?:rgba?|hsla?|oklch|color-mix|var)\([^)]*\)/g, ' ').match(/-?[\d.]+(?:px|r?em)?/g) ?? [];
    const blur = parseFloat(lens[2] ?? '0');
    if (blur > 0) return true;
  }
  return false;
}

// ---------- contrast ----------
/** WCAG 2.x relative luminance of an sRGB colour given as 0..255 channels. */
export function luminance([r, g, b]) {
  const c = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** Large text: 24px and up, or 18.66px and up when bold (700+). */
export const isLargeText = (px, weight) => px >= 24 || (px >= 18.66 && weight >= 700);
export const requiredRatio = (px, weight) => (isLargeText(px, weight) ? 3 : 4.5);

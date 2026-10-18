// Design lint rules: zero-token, deterministic checks that replace LLM review of mechanical things.
// Shared by the static source lint (scripts/design-lint/static.mjs), the query lint (scripts/query-lint) and the
// Playwright checks (e2e/design.spec.ts, e2e/mobile.spec.ts).

/** Smallest tap target, CSS px, both sides. */
export const MIN_TAP = 48;
/** Today at 412x915 may be at most this many phone viewports tall with the synthetic data. */
export const TODAY_MAX_VIEWPORTS = 1.5;
/** Largest layout shift allowed from placeholders to loaded data on Today, Replies and Report (e2e/cls.spec.ts). */
export const MAX_CLS = 0.02;
/** Widths every screen is checked at (playwright.config.ts projects). */
export const WIDTHS = [360, 390, 412];

/** Only these CSS files may use gradients or glow shadows (none today). Paths relative to app2/web. */
export const EFFECTS_ALLOW_LIST = ['src/ui/effects.allowed.css'];
/** The one file that may hold raw colours (Citrine s2/tokens). Every other stylesheet and inline style uses its variables. */
export const TOKENS_FILE = 'src/ui/tokens.css';
/** Every text token on every surface token must reach this (WCAG AA body text), whatever size it ends up used at. */
export const TOKEN_MIN_RATIO = 4.5;

// All literals: dash, buzzword. UI copy only: exclamation, place-or-timezone (TZ, CITY), infra-word.
const BANG = /!/;
const DASH = /[\u2012-\u2015]/; // U+2013, U+2014, figure dash, bar
const BUZZ = /\b(seamless(?:ly)?|empower(?:s|ed|ing|ment)?|unlock(?:s|ed|ing)?|supercharg(?:e|es|ed|ing)|leverag(?:e|es|ed|ing)|elevat(?:e|es|ed|ing)|game[- ]?chang(?:er|ers|ing)|revolutioni[sz](?:e|es|ed|ing)|effortless(?:ly)?|delight(?:s|ed|ful|fully|ing)?|cutting[- ]edge|robust(?:ly|ness)?|world[- ]class)\b/i;
// Time zones are case-sensitive abbreviations and offsets; cities are not.
const TZ = /\b(?:IST|PST|PDT|PT|ET|EST|EDT|CET|GMT|UTC)\b|\b(?:UTC|GMT)\s?[+\u2212-]\d{1,2}(?::?\d{2})?|(?<![\d:])[+\u2212-](?:0\d|1[0-4]):[0-5]\d\b/;
const CITY = /\b(?:bengaluru|bangalore|india|mumbai|delhi|kolkata|san francisco|new york|london|(?:asia|america|europe)\/[a-z_]+)\b/i;
const INFRA = /\b(?:supabase|vercel|postgres(?:ql)?|postgrest|rls|databases?|apis?|tokens?|workers?|cron(?:s|job|jobs)?)\b/i;

/** Every rule an allow may name. Static copy and CSS rules, the query rule, and the rendered dead-tap opt-out. */
export const RULES = ['dash', 'buzzword', 'exclamation', 'place-or-timezone', 'infra-word', 'system-font-primary', 'gradient', 'glow', 'query-unbounded', 'dead-tap',
  'raw-color', 'backdrop-filter', 'token-contrast', 'color-only-status', 'px-font-size', 'raw-motion'];

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

/** A literal colour in a CSS value: hex, or a colour function (var() and color-mix() over variables are fine). */
export const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
/** Glass: blur behind an element. A GPU cost on every scroll frame in WebKit, and the look the lint keeps out. */
export const isBackdropProp = (prop) => /^(?:-webkit-)?backdrop-filter$/.test(prop);

/**
 * Lint one stylesheet for rule 5 plus the Citrine rules.
 * @param {string} css
 * @param {{ allowEffects: boolean, tokens?: boolean, vars?: Map<string, string> }} opts tokens=true for TOKENS_FILE (raw
 *   colours allowed); vars: custom properties defined elsewhere (tokens.css), used to resolve font stacks.
 */
export function lintCss(css, { allowEffects, tokens = false, vars: extVars }) {
  const decls = declarations(css);
  const vars = new Map([...(extVars ?? []), ...decls.filter((d) => d.prop.startsWith('--')).map((d) => [d.prop, d.value])]);
  const out = [];
  for (const d of decls) {
    if (!tokens) { const m = d.value.match(RAW_COLOR); if (m) out.push({ rule: 'raw-color', line: d.line, match: `${d.prop}: ${d.value}` }); }
    if (isBackdropProp(d.prop) && d.value.trim().toLowerCase() !== 'none') out.push({ rule: 'backdrop-filter', line: d.line, match: `${d.prop}: ${d.value}` });
    if (!tokens && (d.prop === 'font-size' || d.prop === 'font') && /(?<![\w.-])[\d.]+px\b/.test(d.value)) out.push({ rule: 'px-font-size', line: d.line, match: `${d.prop}: ${d.value}` });
    if (!tokens && (/cubic-bezier\(|linear\(/i.test(d.value) || /^(?:transition|animation)(?:-duration|-delay)?$/.test(d.prop) && /(?<![\w.-])[\d.]+m?s\b/.test(d.value.replace(/var\([^)]*\)/g, '')))) {
      out.push({ rule: 'raw-motion', line: d.line, match: `${d.prop}: ${d.value}` });
    }
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

/**
 * Text the contrast check skips (besides script/style): inactive controls only, marked aria-disabled="true" (WCAG 1.4.3
 * exempts text in inactive user interface components). Native `disabled` is NOT exempt, and the 4.5:1 / 3:1 thresholds
 * are unchanged for everything else. Inactive controls still get the 48px target check.
 */
export const CONTRAST_EXEMPT = '[aria-disabled="true"]';
/** True when an element with these attributes (its own or an ancestor's) is exempt from the contrast check. */
export const contrastExempt = (attrs) => attrs['aria-disabled'] === 'true';

// ---------- tokens (Citrine) ----------
/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` to [r, g, b, a]; null for anything else. */
export function parseColor(v) {
  const s = String(v).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
    return [n[0], n[1], n[2], n[3] / 255];
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : Number(x)));
    if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null;
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return null;
}
const overOpaque = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
export const isSurfaceToken = (n) => /^--s-[\w-]+$/.test(n);
export const isTextToken = (n) => /^--t-\d+$/.test(n) || n === '--accent' || n === '--alert';
/** Ink-on-fill pairs, checked only against their own fill. The t-1 fill is today's primary button until slot 3 moves the
 *  one primary fill to champagne. */
export const INVERSE_PAIRS = [['--on-accent', '--accent'], ['--on-alert', '--alert'], ['--on-accent', '--t-1']];
/** Text tokens that must never sit on a surface (spec: --t-3 is 4.50:1 on --s-high, no margin). Dropped from the matrix
 *  and enforced by forbiddenPairs() on every stylesheet rule. */
export const FORBIDDEN_PAIRS = [['--t-3', '--s-high']];
/** Core tokens every token file must define. */
export const CORE_TOKENS = ['--s-canvas', '--t-1'];

/**
 * Contrast matrix of a token file. Every text token on every surface token (minus FORBIDDEN_PAIRS), plus INVERSE_PAIRS.
 * A translucent surface (the tab bar) is composited over every opaque surface and over --t-1 (the brightest thing that can sit under
 * it), and the worst backdrop counts. Missing core tokens and unparseable colours are findings too.
 * @param {string} css the token file
 * @returns {{ pairs: { text: string, surface: string, ratio: number, need: number, pass: boolean }[], findings: { rule: string, line: number, match: string }[] }}
 */
export function tokenContrast(css) {
  const decls = declarations(css).filter((d) => d.prop.startsWith('--'));
  const val = new Map(); const line = new Map();
  for (const d of decls) { if (!val.has(d.prop)) { val.set(d.prop, d.value); line.set(d.prop, d.line); } }
  const findings = [];
  const col = (n) => {
    const c = parseColor(val.get(n) ?? '');
    if (!c) findings.push({ rule: 'token-contrast', line: line.get(n) ?? 1, match: `${n}: ${val.get(n) ?? '(missing)'} is not a hex or rgb() colour` });
    return c;
  };
  for (const need of CORE_TOKENS) if (!val.has(need)) findings.push({ rule: 'token-contrast', line: 1, match: `${need} missing` });
  const surfaces = [...val.keys()].filter(isSurfaceToken);
  const texts = [...val.keys()].filter(isTextToken);
  const opaque = surfaces.map((n) => [n, col(n)]).filter(([, c]) => c && c[3] === 1);
  const primary = parseColor(val.get('--t-1') ?? '');
  /** Every backdrop a surface can show: itself when opaque, else composited over each opaque surface and text-primary. */
  const backdrops = (n) => {
    const c = parseColor(val.get(n) ?? '');
    if (!c) return [];
    if (c[3] === 1) return [{ label: n, rgb: c.slice(0, 3) }];
    const unders = [...opaque.map(([u, uc]) => [u, uc]), ...(primary ? [['--t-1', primary]] : [])];
    return unders.map(([u, uc]) => ({ label: `${n} over ${u}`, rgb: overOpaque(c, uc) }));
  };
  const pairs = [];
  const check = (t, s) => {
    const tc = col(t); if (!tc) return;
    const bds = backdrops(s); if (!bds.length) return;
    const worst = bds.map((b) => {
      const fg = tc[3] === 1 ? tc.slice(0, 3) : overOpaque(tc, b.rgb);
      return { label: b.label, ratio: contrast(fg, b.rgb) };
    }).sort((a, b) => a.ratio - b.ratio)[0];
    const pass = worst.ratio + 1e-9 >= TOKEN_MIN_RATIO;
    pairs.push({ text: t, surface: worst.label, ratio: Math.round(worst.ratio * 100) / 100, need: TOKEN_MIN_RATIO, pass });
    if (!pass) findings.push({ rule: 'token-contrast', line: line.get(t) ?? 1, match: `${t} on ${worst.label} is ${worst.ratio.toFixed(2)}:1 < ${TOKEN_MIN_RATIO}:1` });
  };
  const forbidden = (t, s) => FORBIDDEN_PAIRS.some(([a, b]) => a === t && b === s);
  for (const s of surfaces) for (const t of texts) if (!forbidden(t, s)) check(t, s);
  for (const [t, s] of INVERSE_PAIRS) if (val.has(t) && val.has(s)) check(t, s);
  return { pairs, findings };
}

/** Hex colours in a file that cannot read CSS variables (index.html, the manifest) that match no token value. */
export function colorDrift(text, tokensCss) {
  const known = new Set(declarations(tokensCss).filter((d) => d.prop.startsWith('--')).map((d) => parseColor(d.value)).filter(Boolean).map((c) => c.join(',')));
  const out = [];
  for (const m of text.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
    const c = parseColor(m[0]);
    if (!c || !known.has(c.join(','))) out.push({ match: m[0], index: m.index ?? 0 });
  }
  return out;
}

// ---------- status ----------
/**
 * Status elements: a live region, an alert, anything tagged data-status, and the pill/tag/badge/dot shapes. Each one that
 * is drawn (non-zero box) must carry text or a glyph (its own text content), so the status never rests on colour alone.
 */
export const STATUS_SEL = '[role=status], [role=alert], [data-status], .tag, .badge, .dot, .pill, .ropill';
/** @param {{ label: string, text: string, w: number, h: number }[]} items @returns {string[]} */
export function colorOnlyStatus(items) {
  return items.filter((x) => x.w > 0 && x.h > 0 && !x.text.trim()).map((x) => `${x.label} ${x.w | 0}x${x.h | 0} has no text or glyph`);
}

/**
 * Stylesheet rules that put a forbidden text token on a forbidden surface in the same block (color and background).
 * @param {string} css @returns {{ line: number, match: string }[]}
 */
export function forbiddenPairs(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    const color = body.match(/(?:^|;|\s)color\s*:\s*var\((--[\w-]+)\)/)?.[1];
    const bg = body.match(/background(?:-color)?\s*:\s*var\((--[\w-]+)\)/)?.[1];
    if (color && bg && FORBIDDEN_PAIRS.some(([t, s]) => t === color && s === bg)) {
      out.push({ line: clean.slice(0, m.index).split('\n').length + (m[1].match(/^\s*/)?.[0].split('\n').length ?? 1) - 1, match: `${m[1].trim()} { color: var(${color}); background: var(${bg}) }` });
    }
  }
  return out;
}

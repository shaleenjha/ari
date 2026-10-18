#!/usr/bin/env node
// Static half of the design lint: UI copy rules (spec 02 §1) and CSS rules. No browser, no network, no tokens.
//   node scripts/design-lint/static.mjs            lint app2/web
//   node scripts/design-lint/static.mjs --json     machine-readable output
// Copy: banned strings in source literals (all .ts/.tsx under src, tests and .d.ts excluded: dash, buzzword) and UI copy
//       (JSX text and copy literals in .tsx, index.html text and title/alt/aria-label/placeholder/content, manifest
//       name/short_name/description: also exclamation, place-or-timezone, infra-word).
// CSS:  system font as the primary family, gradients and glow shadows (src/**/*.css and inline styles) outside
//       EFFECTS_ALLOW_LIST. Citrine (v18.16.0): raw colours outside TOKENS_FILE (CSS and inline styles), backdrop-filter
//       anywhere, every text token on every surface token >= 4.5:1 (computed from tokens.css), hex colours in index.html
//       and the manifest must equal a token value (they cannot read variables), status elements with no content.
//   node scripts/design-lint/static.mjs --tokens   also print the token contrast matrix
// Allows: see allow.mjs (allow.json per file, inline `lint-allow: <rule> <reason>`). Exit 1 on any error; CI=true adds
// GitHub annotations.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { EFFECTS_ALLOW_LIST, TOKENS_FILE, checkText, colorDrift, declarations, lintCss, tokenContrast } from './rules.mjs';
import { WEB_ROOT, allowIndex, finding, loadAllowJson, printFindings, staleJsonEntries } from './allow.mjs';

const ROOT = WEB_ROOT;
/** Rules this lint owns (stale allows for other rules are left to their own lint). */
export const STATIC_RULES = new Set(['dash', 'buzzword', 'exclamation', 'place-or-timezone', 'infra-word', 'system-font-primary', 'gradient', 'glow',
  'raw-color', 'backdrop-filter', 'token-contrast', 'color-only-status']);

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

// JSX attributes whose values are never shown to people.
const NON_COPY_ATTRS = new Set(['className', 'data-testid', 'href', 'id', 'key', 'role', 'type', 'htmlFor', 'rel', 'target', 'src', 'lang', 'name', 'method', 'action', 'autoComplete', 'inputMode', 'data-lint-allow']);

function isCodeLiteral(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isJsxAttribute(p)) return NON_COPY_ATTRS.has(p.name.getText());
  if (ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) return NON_COPY_ATTRS.has(p.parent.name.getText());
  // className={a ? 'btn' : 'btn ghost'}
  for (let q = p; q && !ts.isSourceFile(q); q = q.parent) {
    if (ts.isJsxAttribute(q)) return NON_COPY_ATTRS.has(q.name.getText());
    if (ts.isJsxElement(q) || ts.isJsxSelfClosingElement(q) || ts.isBlock(q)) break;
  }
  return false;
}

/** 1-based line and column of offset `pos` in `text`. */
function lineCol(text, pos) {
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  return { line, col: pos - before.lastIndexOf('\n') };
}

/** Offset of `match` inside the node's raw source, falling back to the first non-blank character of the node. */
function matchPos(src, node, match) {
  const start = node.getStart(src);
  const raw = src.text.slice(start, node.getEnd());
  const i = raw.indexOf(match);
  if (i >= 0) return start + i;
  const nb = raw.search(/\S/);
  return start + Math.max(0, nb);
}

/**
 * Lint one .ts/.tsx source for copy and inline-style rules. Returns findings with allows applied, plus allow problems.
 * @param {string} file path relative to app2/web
 * @param {string} text
 * @param {{ jsonEntries?: Map<string, {rule: string, used: boolean}[]> }} [opts]
 */
export function lintSource(file, text, { jsonEntries } = {}) {
  const tsx = file.endsWith('.tsx');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const allow = allowIndex(file, text, jsonEntries);
  const out = [];
  const push = (pos, rule, match, value, kind) => {
    const { line, col } = lineCol(text, pos);
    if (allow.suppress(rule, line)) return;
    out.push({ ...finding(file, line, col, rule, match, value.trim().replace(/\s+/g, ' ').slice(0, 80)), kind });
  };
  const report = (node, value, copy) => {
    for (const v of checkText(value, { copy })) push(matchPos(src, node, v.match), v.rule, v.match, value, copy ? 'in UI copy' : 'in a source literal');
  };
  const visit = (node) => {
    if (ts.isRegularExpressionLiteral(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      report(node, node.text, tsx && !isCodeLiteral(node));
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
      report(node, parts, tsx && !isCodeLiteral(node));
    } else if (ts.isJsxText(node)) {
      if (node.text.trim()) report(node, node.text, true);
    }
    // inline styles: style={{ background: 'linear-gradient(...)' }}
    if (ts.isJsxAttribute(node) && node.name.getText() === 'style' && node.initializer) {
      const t = node.initializer.getText(src);
      const pos = node.getStart(src);
      if (/gradient\s*\(/i.test(t)) push(pos, 'gradient', 'inline style', t, 'in an inline style');
      if (/boxShadow|textShadow/.test(t)) push(pos, 'glow', 'inline style', t, 'in an inline style');
      if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(t)) push(pos, 'raw-color', 'inline style', t, 'in an inline style');
      if (/backdropFilter|WebkitBackdropFilter/.test(t)) push(pos, 'backdrop-filter', 'inline style', t, 'in an inline style');
    }
    // <span role="status" /> or <i data-status="ok" />: a status with no children can only be colour.
    if (ts.isJsxSelfClosingElement(node)) {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const role = attrs.find((a) => a.name.getText() === 'role')?.initializer?.getText(src).replace(/['"{}]/g, '');
      if (role === 'status' || role === 'alert' || attrs.some((a) => a.name.getText() === 'data-status')) {
        push(node.getStart(src), 'color-only-status', node.tagName.getText(src), node.getText(src), 'in JSX');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return [...out, ...allow.problems(STATIC_RULES)];
}

/** Lint one stylesheet (CSS rules) with allows applied. */
export function lintCssFile(file, text, { jsonEntries, vars } = {}) {
  const allow = allowIndex(file, text, jsonEntries);
  const out = lintCss(text, { allowEffects: EFFECTS_ALLOW_LIST.includes(file), tokens: file === TOKENS_FILE, vars })
    .filter((x) => !allow.suppress(x.rule, x.line))
    .map((x) => ({ ...finding(file, x.line, 1, x.rule, x.match, x.match), kind: 'in CSS' }));
  return [...out, ...allow.problems(STATIC_RULES)];
}

export function lintHtmlCopy(file, html, { jsonEntries } = {}) {
  const allow = allowIndex(file, html, jsonEntries);
  const out = [];
  // Blank out script, style and comment bodies but keep offsets, so lines and columns stay true.
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, blank).replace(/<style[\s\S]*?<\/style>/gi, blank).replace(/<!--[\s\S]*?-->/g, blank);
  const pieces = [
    ...[...body.matchAll(/>([^<>]+)</g)].map((m) => ({ t: m[1], at: (m.index ?? 0) + 1 })).filter((x) => x.t.trim()),
    ...[...body.matchAll(/\b(?:title|alt|aria-label|placeholder|content)="([^"]*)"/g)]
      .map((m) => ({ t: m[1], at: (m.index ?? 0) + m[0].indexOf('"') + 1 })).filter((x) => !/^[#\d]|width=|^text\//.test(x.t)),
  ];
  for (const { t, at } of pieces) for (const v of checkText(t, { copy: true })) {
    const { line, col } = lineCol(html, at + Math.max(0, t.indexOf(v.match)));
    if (allow.suppress(v.rule, line)) continue;
    out.push({ ...finding(file, line, col, v.rule, v.match, t.trim().slice(0, 80)), kind: 'in UI copy' });
  }
  return [...out, ...allow.problems(STATIC_RULES)];
}

export function lintManifestCopy(file, json, { jsonEntries } = {}) {
  const m = JSON.parse(json);
  const allow = allowIndex(file, '', jsonEntries);
  const out = [];
  for (const k of ['name', 'short_name', 'description']) if (typeof m[k] === 'string') for (const v of checkText(m[k], { copy: true })) {
    const pos = json.indexOf(`"${k}"`);
    const { line, col } = lineCol(json, Math.max(0, pos));
    if (allow.suppress(v.rule, line)) continue;
    out.push({ ...finding(file, line, col, v.rule, v.match, m[k]), kind: 'in UI copy' });
  }
  return out;
}

/**
 * Token file checks: the contrast matrix (rule token-contrast) and hex colours in files that cannot read variables
 * (index.html, the manifest) that match no token (rule raw-color).
 */
export function lintTokens(tokensCss, mirrors) {
  const { pairs, findings: tf } = tokenContrast(tokensCss);
  const out = tf.map((x) => ({ ...finding(TOKENS_FILE, x.line, 1, x.rule, x.match, x.match), kind: 'in the token file' }));
  for (const [file, text] of mirrors) for (const d of colorDrift(text, tokensCss)) {
    const { line, col } = lineCol(text, d.index);
    out.push({ ...finding(file, line, col, 'raw-color', d.match, `${d.match} is not a value in ${TOKENS_FILE}; mirror the token`), kind: 'mirroring the tokens' });
  }
  return { pairs, findings: out };
}

export function run(root = ROOT, { allowJson = join(root, 'scripts/design-lint/allow.json') } = {}) {
  const { entries: jsonEntries, problems } = loadAllowJson(allowJson, root);
  const findings = [...problems];
  const files = walk(join(root, 'src'));
  const tokensPath = join(root, TOKENS_FILE);
  const tokensCss = existsSync(tokensPath) ? readFileSync(tokensPath, 'utf8') : '';
  if (!tokensCss) findings.push({ ...finding(TOKENS_FILE, 1, 1, 'token-contrast', TOKENS_FILE, `${TOKENS_FILE} is missing`), kind: '' });
  const vars = new Map(declarations(tokensCss).filter((d) => d.prop.startsWith('--')).map((d) => [d.prop, d.value]));
  for (const f of files) {
    const rel = relative(root, f);
    const text = readFileSync(f, 'utf8');
    if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('.d.ts')) findings.push(...lintSource(rel, text, { jsonEntries }));
    if (f.endsWith('.css')) findings.push(...lintCssFile(rel, text, { jsonEntries, vars }));
  }
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const manifest = readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8');
  findings.push(...lintHtmlCopy('index.html', html, { jsonEntries }));
  findings.push(...lintManifestCopy('public/manifest.webmanifest', manifest, { jsonEntries }));
  const tk = lintTokens(tokensCss, [['index.html', html], ['public/manifest.webmanifest', manifest]]);
  findings.push(...tk.findings);
  findings.push(...staleJsonEntries(jsonEntries, STATIC_RULES));
  return { files: files.length + 2, findings, pairs: tk.pairs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, findings, pairs } = run();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ files, findings, pairs }, null, 2));
    process.exit(findings.some((f) => f.severity !== 'warning') ? 1 : 0);
  }
  if (process.argv.includes('--tokens')) for (const p of pairs) console.log(`${p.pass ? 'ok  ' : 'FAIL'} ${p.ratio.toFixed(2).padStart(5)}:1  ${p.text} on ${p.surface}`);
  const low = pairs.reduce((m, p) => Math.min(m, p.ratio), Infinity);
  const errors = printFindings(findings, { label: 'design-lint (static)', okLine: `${files} files, copy rules, CSS rules, ${pairs.length} token pairs (lowest ${low.toFixed(2)}:1)`, kind: (f) => f.kind ?? '' });
  process.exit(errors ? 1 : 0);
}

#!/usr/bin/env node
// Static half of the design lint (rules 3 and 5). No browser, no network, no tokens.
//   node scripts/design-lint/static.mjs            lint app2/web
//   node scripts/design-lint/static.mjs --json     machine-readable output
// Rule 3: banned strings in source string literals (all .ts/.tsx under src, tests excluded) and UI copy (JSX text and
//         copy literals in .tsx, index.html, manifest). Rule 5: system font as the primary family, gradients and glow
//         shadows in CSS (src/**/*.css) and inline styles, outside EFFECTS_ALLOW_LIST.
// Escape hatch, one line at a time and reviewed in the PR: `// design-lint-allow: <reason>` on the line above.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { EFFECTS_ALLOW_LIST, checkText, lintCss } from './rules.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

// JSX attributes whose values are never shown to people.
const NON_COPY_ATTRS = new Set(['className', 'data-testid', 'href', 'id', 'key', 'role', 'type', 'htmlFor', 'rel', 'target', 'src', 'lang', 'name', 'method', 'action', 'autoComplete', 'inputMode']);

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

function allowed(src, pos) {
  const lines = src.text.split('\n');
  const line = src.getLineAndCharacterOfPosition(pos).line;
  return /design-lint-allow:/.test(lines[line - 1] ?? '') || /design-lint-allow:/.test(lines[line] ?? '');
}

export function lintSource(file, text) {
  const tsx = file.endsWith('.tsx');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const report = (node, value, copy) => {
    if (allowed(src, node.getStart(src))) return;
    for (const v of checkText(value, { copy })) {
      out.push({ file, line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, ...v, text: value.trim().slice(0, 80) });
    }
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      report(node, node.text, tsx && !isCodeLiteral(node));
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
      report(node, parts, tsx && !isCodeLiteral(node));
    } else if (ts.isJsxText(node)) {
      if (node.text.trim()) report(node, node.text, true);
    } else if (ts.isRegularExpressionLiteral(node)) {
      return;
    }
    // inline styles: style={{ background: 'linear-gradient(...)' }}
    if (ts.isJsxAttribute(node) && node.name.getText() === 'style' && node.initializer) {
      const t = node.initializer.getText(src);
      if (/gradient\s*\(/i.test(t)) out.push({ file, line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, rule: 'gradient', match: 'inline style', text: t.slice(0, 80) });
      if (/boxShadow|textShadow/.test(t)) out.push({ file, line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, rule: 'glow', match: 'inline style', text: t.slice(0, 80) });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

export function lintHtmlCopy(file, html) {
  const out = [];
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const texts = [...body.matchAll(/>([^<>]+)</g)].map((m) => m[1]).filter((t) => t.trim() && !t.trim().startsWith('<!'));
  const attrs = [...body.matchAll(/\b(?:title|alt|aria-label|placeholder|content)="([^"]*)"/g)].map((m) => m[1]).filter((v) => !/^[#\d]|width=|^text\//.test(v));
  for (const t of [...texts, ...attrs]) for (const v of checkText(t, { copy: true })) out.push({ file, line: 0, ...v, text: t.trim().slice(0, 80) });
  return out;
}

export function lintManifestCopy(file, json) {
  const m = JSON.parse(json);
  const out = [];
  for (const k of ['name', 'short_name', 'description']) if (typeof m[k] === 'string') for (const v of checkText(m[k], { copy: true })) out.push({ file, line: 0, ...v, text: m[k] });
  return out;
}

export function run(root = ROOT) {
  const findings = [];
  const files = walk(join(root, 'src'));
  for (const f of files) {
    const rel = relative(root, f);
    const text = readFileSync(f, 'utf8');
    if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('.d.ts')) findings.push(...lintSource(rel, text));
    if (f.endsWith('.css')) {
      findings.push(...lintCss(text, { allowEffects: EFFECTS_ALLOW_LIST.includes(rel) }).map((x) => ({ file: rel, ...x, text: x.match })));
    }
  }
  findings.push(...lintHtmlCopy('index.html', readFileSync(join(root, 'index.html'), 'utf8')));
  findings.push(...lintManifestCopy('public/manifest.webmanifest', readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8')));
  return { files: files.length + 2, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, findings } = run();
  if (process.argv.includes('--json')) console.log(JSON.stringify({ files, findings }, null, 2));
  else {
    for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}  "${f.match}"  in: ${f.text}`);
    console.log(findings.length ? `design-lint (static): ${findings.length} problem(s) in ${files} files` : `design-lint (static): OK, ${files} files, rules 3 (source copy) and 5 (fonts, gradients, glows)`);
  }
  process.exit(findings.length ? 1 : 0);
}

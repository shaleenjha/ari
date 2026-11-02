// Allow mechanics shared by the static copy lint (static.mjs) and the query lint (../query-lint/query-lint.mjs).
//
//  1. scripts/design-lint/allow.json: { "<path relative to app/web>": ["<rule>", "<rule> <reason>"] } turns rules off
//     for a whole file. Add an entry only for a genuine false positive, and give the reason after the rule name.
//  2. Inline, on the same line or the line above the finding, suppressing only that rule:
//        // lint-allow: <rule> <reason>        TS / JS
//        {/* lint-allow: <rule> <reason> */}  JSX
//        /* lint-allow: <rule> <reason> */    CSS
//        <!-- lint-allow: <rule> <reason> --> HTML
//     A missing reason or an unknown rule is `lint-allow-invalid` (error). The legacy `design-lint-allow:` marker is
//     rejected the same way. An allow that suppresses nothing is `lint-allow-stale` (warning).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from './rules.mjs';

export const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Repo root: CI annotations name files relative to it (app/web/...). */
export const REPO_ROOT = resolve(WEB_ROOT, '../..');
export const ALLOW_JSON = join(WEB_ROOT, 'scripts/design-lint/allow.json');

const KNOWN = new Set(RULES);
const MARKER = /(?:\/\/|\/\*|<!--)\s*(design-)?lint-allow:([^\n]*)/g;

/**
 * Parse every inline allow in a file.
 * @returns {{ line: number, col: number, rule: string, reason: string, problem: string | null, used: boolean }[]}
 */
export function parseInlineAllows(text) {
  const out = [];
  text.split('\n').forEach((src, i) => {
    for (const m of src.matchAll(MARKER)) {
      const body = m[2].replace(/\s*(?:\*\/\s*\}?|-->)[\s\S]*$/, '').trim();
      const [rule = '', ...rest] = body.split(/\s+/);
      const reason = rest.join(' ').trim();
      let problem = null;
      if (m[1]) problem = 'legacy "design-lint-allow:" marker; use "lint-allow: <rule> <reason>"';
      else if (!rule) problem = 'no rule named';
      else if (!KNOWN.has(rule)) problem = `unknown rule "${rule}"`;
      else if (!reason) problem = `no reason given for "${rule}"`;
      out.push({ line: i + 1, col: (m.index ?? 0) + 1, rule, reason, problem, used: false });
    }
  });
  return out;
}

/** Read allow.json. Returns per-file entries and file-level problems (invalid rules, missing paths). */
export function loadAllowJson(path = ALLOW_JSON, webRoot = WEB_ROOT) {
  const entries = new Map(); // relPath -> [{ rule, reason, used }]
  const problems = [];
  if (!existsSync(path)) return { entries, problems };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const rel = relative(webRoot, path);
  for (const [file, rules] of Object.entries(raw)) {
    if (file.startsWith('//') || file.startsWith('$')) continue; // comment keys
    if (!Array.isArray(rules)) { problems.push(finding(rel, 1, 1, 'lint-allow-invalid', file, `"${file}" must map to an array of "<rule> <reason>" strings`)); continue; }
    if (!existsSync(join(webRoot, file))) problems.push({ ...finding(rel, 1, 1, 'lint-allow-stale', file, `allow.json path "${file}" no longer exists`), severity: 'warning' });
    const list = [];
    for (const r of rules) {
      const [rule = '', ...rest] = String(r).trim().split(/\s+/);
      if (!KNOWN.has(rule)) { problems.push(finding(rel, 1, 1, 'lint-allow-invalid', String(r), `allow.json "${file}": unknown rule "${rule}"`)); continue; }
      list.push({ rule, reason: rest.join(' '), used: false });
    }
    entries.set(file, list);
  }
  return { entries, problems };
}

/**
 * Allow index for one file: decides whether a finding is suppressed and records which allows were used.
 * @param {string} file path relative to app/web
 * @param {string} text file contents
 * @param {Map<string, {rule: string, used: boolean}[]>} [jsonEntries]
 */
export function allowIndex(file, text, jsonEntries = new Map()) {
  const inline = parseInlineAllows(text);
  const fileLevel = jsonEntries.get(file) ?? [];
  return {
    inline,
    /** True when `rule` at 1-based `line` is allowed (file-level or inline on this line or the line above). */
    suppress(rule, line) {
      const f = fileLevel.find((e) => e.rule === rule);
      if (f) { f.used = true; return true; }
      const a = inline.find((x) => !x.problem && x.rule === rule && (x.line === line || x.line === line - 1));
      if (a) { a.used = true; return true; }
      return false;
    },
    /**
     * lint-allow-invalid errors (when reportInvalid) and lint-allow-stale warnings for the rules this linter owns.
     * @param {Set<string>} ownRules
     */
    problems(ownRules, { reportInvalid = true } = {}) {
      const out = [];
      for (const a of inline) {
        if (a.problem) { if (reportInvalid) out.push(finding(file, a.line, a.col, 'lint-allow-invalid', a.rule || 'lint-allow', a.problem)); continue; }
        if (ownRules.has(a.rule) && !a.used) out.push({ ...finding(file, a.line, a.col, 'lint-allow-stale', a.rule, `lint-allow: ${a.rule} suppresses nothing`), severity: 'warning' });
      }
      return out;
    },
  };
}

/** One finding. severity defaults to error. */
export function finding(file, line, col, rule, match, text, severity = 'error') {
  return { file, line, col, rule, match, text, severity };
}

/** Unused allow.json entries for the given rules, as warnings. */
export function staleJsonEntries(entries, ownRules) {
  const out = [];
  for (const [file, list] of entries) for (const e of list) if (ownRules.has(e.rule) && !e.used) {
    out.push(finding('scripts/design-lint/allow.json', 1, 1, 'lint-allow-stale', e.rule, `allow.json "${file}": ${e.rule} suppresses nothing`, 'warning'));
  }
  return out;
}

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** Print findings (errors and warnings) and GitHub annotations when CI=true. Returns the error count. */
export function printFindings(findings, { label, okLine, kind = (f) => f.text }) {
  const ci = process.env.CI === 'true';
  const sorted = [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
  for (const f of sorted) {
    const sev = f.severity === 'warning' ? 'warning ' : '';
    console.log(`${f.file}:${f.line}:${f.col}  ${sev}${f.rule}  "${f.match}"  in: ${f.text}`);
    if (ci) {
      const file = relative(REPO_ROOT, resolve(WEB_ROOT, f.file));
      console.log(`::${f.severity === 'warning' ? 'warning' : 'error'} file=${file},line=${f.line},col=${f.col},title=${f.rule}::${esc(`"${f.match}" ${kind(f)}`)}`);
    }
  }
  const errors = findings.filter((f) => f.severity !== 'warning').length;
  const warnings = findings.length - errors;
  console.log(errors ? `${label}: ${errors} error(s), ${warnings} warning(s)` : `${label}: OK, ${okLine}${warnings ? `, ${warnings} warning(s)` : ''}`);
  return errors;
}

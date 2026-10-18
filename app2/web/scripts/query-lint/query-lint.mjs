#!/usr/bin/env node
// Query safety lint (spec 02 §3). Rule `no-client-writes` (no-client-writes.mjs): app2/web/src makes no writes at all.
// Rule `query-unbounded`: a `.from(..)` chain that `.select(..)`s needs
// `.limit|.range|.single|.maybeSingle` on the same chain, or on the variable it is assigned to (unconditionally: a
// terminator inside if / ?: / a loop / a closure does not count). Exempt: `{ head: true }` counts, and selects that follow
// insert/upsert/update/delete.
//   node scripts/query-lint/query-lint.mjs     lint the app2/web and app2/jobs TypeScript programs
// Allows: allow.json (paths relative to app2/web, so jobs files are "../jobs/src/...") and inline
// `// lint-allow: query-unbounded <reason>`, same as the static lint (scripts/design-lint/allow.mjs).
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { lintWrites } from './no-client-writes.mjs';
import { WEB_ROOT, allowIndex, finding as mkFinding, loadAllowJson, printFindings, staleJsonEntries } from '../design-lint/allow.mjs';

const TERM = new Set(['limit', 'range', 'single', 'maybeSingle']);
const MUT = new Set(['insert', 'upsert', 'update', 'delete']);
const OWN = new Set(['query-unbounded']);
/** Files the static lint already checks for invalid allows. */
const STATIC_SCOPE = join(WEB_ROOT, 'src') + '/';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures') + '/';

function outward(node) {
  const names = []; let n = node;
  while (ts.isPropertyAccessExpression(n.parent) && ts.isCallExpression(n.parent.parent)) { names.push(n.parent.name.text); n = n.parent.parent; }
  return { names, top: n };
}

/**
 * @param {ts.Program} program
 * @param {{ root?: string, jsonEntries?: Map<string, any[]>, exclude?: (fileName: string) => boolean, indexes?: Map<string, any> }} [opts]
 */
export function lintQueries(program, { root = WEB_ROOT, jsonEntries = new Map(), exclude = () => false, indexes = new Map() } = {}) {
  const checker = program.getTypeChecker(); const out = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || /node_modules|\.test\./.test(sf.fileName) || exclude(sf.fileName)) continue;
    const rel = relative(root, sf.fileName);
    if (!indexes.has(sf.fileName)) indexes.set(sf.fileName, { rel, sf, idx: allowIndex(rel, sf.text, jsonEntries) });
    const { idx } = indexes.get(sf.fileName);
    const allowed = (node, rule) => idx.suppress(rule, sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    const finding = (node, msg) => {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return mkFinding(rel, line + 1, character + 1, 'query-unbounded', node.getText(sf).replace(/\s+/g, ' ').slice(0, 60), msg);
    };
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'from') {
        const { names, top } = outward(node);
        const sel = names.indexOf('select');
        if (sel >= 0 && !names.slice(0, sel).some((m) => MUT.has(m)) && !names.some((m) => TERM.has(m)) && !/head:\s*true/.test(top.getText(sf)) && !viaVariable(top, checker)) {
          if (!allowed(node, 'query-unbounded')) out.push(finding(node, `.from().select() without ${[...TERM].join('/')}`));
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
  let p = top.parent; while (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
  const decl = p && ts.isVariableDeclaration(p) ? p : null;
  if (!decl || !ts.isIdentifier(decl.name)) return false;
  const sym = checker.getSymbolAtLocation(decl.name);
  if (!sym) return false;
  const block = decl.parent.parent.parent;
  let ok = false;
  const scan = (n) => {
    if (ts.isIdentifier(n) && n !== decl.name && checker.getSymbolAtLocation(n) === sym) {
      const { names } = outward(n);
      let cond = false;
      for (let s = n.parent; s && s !== block; s = s.parent)
        if (ts.isIfStatement(s) || ts.isConditionalExpression(s) || ts.isIterationStatement(s, false) || ts.isFunctionLike(s)) cond = true;
      if (!cond && names.some((m) => TERM.has(m))) ok = true;
    }
    ts.forEachChild(n, scan);
  };
  scan(block);
  return ok;
}

/** Program from a tsconfig.json. */
export function programFor(tsconfig) {
  const cfg = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (cfg.error) throw new Error(ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dirname(tsconfig));
  return ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
}

/** Lint both app2 programs. */
export function run({ root = WEB_ROOT, allowJson = join(root, 'scripts/design-lint/allow.json') } = {}) {
  const { entries: jsonEntries } = loadAllowJson(allowJson, root); // allow.json problems are reported by the static lint
  const configs = [join(root, 'tsconfig.json'), resolve(root, '../jobs/tsconfig.json')].filter((p) => existsSync(p));
  const indexes = new Map();
  const findings = [];
  const seen = new Set();
  for (const c of configs) {
    const program = programFor(c);
    findings.push(...lintQueries(program, { root, jsonEntries, indexes, exclude: (f) => f.startsWith(FIXTURES) || seen.has(f) }));
    // no-client-writes: app2/web/src only (jobs write by design), no allow escape, tests and fixtures exempt.
    findings.push(...lintWrites(program, { root, include: (f) => f.startsWith(join(root, 'src') + '/') && !seen.has(f) }));
    for (const sf of program.getSourceFiles()) seen.add(sf.fileName);
  }
  for (const { sf, idx } of indexes.values()) {
    findings.push(...idx.problems(OWN, { reportInvalid: !sf.fileName.startsWith(STATIC_SCOPE) }));
  }
  findings.push(...staleJsonEntries(jsonEntries, OWN));
  return { programs: configs.length, files: indexes.size, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { programs, files, findings } = run();
  const errors = printFindings(findings, { label: 'query-lint', okLine: `${files} files in ${programs} programs, no unbounded selects, no client writes`, kind: (f) => f.text });
  process.exit(errors ? 1 : 0);
}

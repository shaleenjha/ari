// Rule `no-client-writes` (Phase 1, read-only app2/web). Blocking, no allow escape: an inline `lint-allow: no-client-writes`
// or an allow.json entry is itself an error. The only places a write may appear are tests (`*.test.ts(x)`) and fixtures
// (any path with a `fixtures/` segment), which are skipped.
// What it reports in app2/web/src:
//   1. any `.rpc(` call, on any receiver;
//   2. `.insert( / .upsert(` on any receiver; `.update( / .delete(` unless the receiver is a plain collection (Set, Map,
//      WeakSet, WeakMap, URLSearchParams, Headers, FormData); `.upload( / .remove( / .move( / .copy(` on a `.storage` chain;
//   3. a fetch-like call (callee named fetch, or any call that returns Promise<Response>) or `new Request(..)` whose init
//      is not an object literal, spreads into the init, or sets `method` to anything but a 'GET' / 'HEAD' string literal.
//      Sign-in is the one exception: a non-GET whose URL is written in place and names the auth path (`/auth/v1/`) and not
//      the data path (`/rest/v1`);
//   4. `navigator.sendBeacon(..)` and `XMLHttpRequest#open(..)` with anything but a 'GET' literal.
import { relative } from 'node:path';
import ts from 'typescript';

export const RULE = 'no-client-writes';
const ALWAYS = new Set(['rpc', 'insert', 'upsert']);
const UNLESS_COLLECTION = new Set(['update', 'delete']);
const STORAGE = new Set(['upload', 'remove', 'move', 'copy']);
const COLLECTIONS = new Set(['Set', 'Map', 'WeakSet', 'WeakMap', 'ReadonlySet', 'ReadonlyMap', 'URLSearchParams', 'Headers', 'FormData', 'DOMTokenList']);
const READ_METHODS = new Set(['GET', 'HEAD']);
const ALLOW_MARKER = /lint-allow:\s*no-client-writes\b/;

/** Tests and fixtures are the only exempt files. */
export const isExempt = (fileName) => /\.test\.tsx?$/.test(fileName) || /(^|[\\/])fixtures[\\/]/.test(fileName);

/** Static text of a URL argument written in place (string, template), or null when it is computed elsewhere. */
function staticText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join('\u0000');
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = staticText(node.left); const r = staticText(node.right);
    return [l, r].filter((x) => x !== null).join('\u0000') || null;
  }
  return null;
}

const isAuthUrl = (node) => {
  const t = node ? staticText(node) : null;
  return t !== null && t.includes('/auth/v1/') && !t.includes('/rest/v1');
};

/** Why an init argument makes this request a possible write, or null when it is a plain read. */
function initProblem(init) {
  if (!init) return null;                                                       // fetch(url): GET
  if (!ts.isObjectLiteralExpression(init)) return 'request options must be an object literal so the method can be checked';
  for (const p of init.properties) {
    if (ts.isSpreadAssignment(p)) return 'request options spread another object; the method cannot be checked';
    const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
    if (name !== 'method') continue;
    if (ts.isShorthandPropertyAssignment(p)) return 'method comes from a variable';
    const v = ts.isPropertyAssignment(p) ? p.initializer : null;
    if (!v || !(ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))) return 'method is not a string literal';
    if (!READ_METHODS.has(v.text.toUpperCase())) return `method ${v.text}`;
  }
  return null;
}

function returnsResponse(call, checker) {
  const sig = checker.getResolvedSignature(call);
  if (!sig) return false;
  return /^Promise<Response>$/.test(checker.typeToString(checker.getReturnTypeOfSignature(sig)));
}

function receiverTypeName(expr, checker) {
  const t = checker.getTypeAtLocation(expr);
  const s = t.getSymbol() ?? t.aliasSymbol;
  return s ? s.getName() : checker.typeToString(t);
}

/**
 * @param {ts.Program} program
 * @param {{ root: string, include: (fileName: string) => boolean, exempt?: (fileName: string) => boolean }} opts
 *   exempt defaults to isExempt (tests and fixtures); the unit test lints its own fixtures by passing () => false.
 */
export function lintWrites(program, { root, include, exempt = isExempt }) {
  const checker = program.getTypeChecker();
  const out = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || /node_modules/.test(sf.fileName) || !include(sf.fileName) || exempt(sf.fileName)) continue;
    const rel = relative(root, sf.fileName);
    const report = (node, msg) => {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ file: rel, line: line + 1, col: character + 1, rule: RULE, match: node.getText(sf).replace(/\s+/g, ' ').slice(0, 60), text: msg, severity: 'error' });
    };
    sf.text.split('\n').forEach((l, i) => {
      if (ALLOW_MARKER.test(l)) out.push({ file: rel, line: i + 1, col: l.search(ALLOW_MARKER) + 1, rule: RULE, match: 'lint-allow: no-client-writes',
        text: 'no-client-writes has no allow escape; move the write to a test or fixture', severity: 'error' });
    });
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;
        if (ts.isPropertyAccessExpression(callee) && name) {
          if (ALWAYS.has(name)) report(node, `.${name}() is a write; the app is read-only`);
          else if (UNLESS_COLLECTION.has(name) && !COLLECTIONS.has(receiverTypeName(callee.expression, checker))) report(node, `.${name}() is a write; the app is read-only`);
          else if (STORAGE.has(name) && /\.storage\b/.test(callee.expression.getText(sf))) report(node, `storage .${name}() is a write; the app is read-only`);
          else if (name === 'sendBeacon') report(node, 'sendBeacon posts data; the app is read-only');
          else if (name === 'open' && receiverTypeName(callee.expression, checker) === 'XMLHttpRequest') {
            const m = node.arguments[0];
            if (!m || !(ts.isStringLiteral(m) && READ_METHODS.has(m.text.toUpperCase()))) report(node, 'XMLHttpRequest with a non-GET method');
          }
        }
        const fetchLike = name === 'fetch' || returnsResponse(node, checker);
        if (fetchLike && name !== 'json' && name !== 'text') {
          const why = initProblem(node.arguments[1]);
          if (why && !isAuthUrl(node.arguments[0])) report(node, `request may write (${why}); only GET reads are allowed`);
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Request') {
        const why = initProblem(node.arguments?.[1]);
        if (why && !isAuthUrl(node.arguments?.[0])) report(node, `request may write (${why}); only GET reads are allowed`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

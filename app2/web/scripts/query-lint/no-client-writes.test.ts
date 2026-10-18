import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isExempt, lintWrites } from './no-client-writes.mjs';
import { run } from './query-lint.mjs';

const dir = join(import.meta.dirname, 'fixtures');
const program = (f: string) => ts.createProgram([join(dir, f)], { noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], strict: false });
const lint = (f: string) => lintWrites(program(f), { root: dir, include: (n) => n.startsWith(dir), exempt: () => false });
const expectedLines = (f: string) =>
  readFileSync(join(dir, f), 'utf8').split('\n').flatMap((l, i) => (/\/\/ expect: no-client-writes/.test(l) ? [i + 1] : []));

describe('no-client-writes', () => {
  it('writes-fail.ts reports exactly its // expect lines', () => {
    const got = lint('writes-fail.ts');
    expect(got.every((f) => f.rule === 'no-client-writes' && f.severity === 'error')).toBe(true);
    expect([...new Set(got.map((f) => f.line))].sort((a, b) => a - b)).toEqual(expectedLines('writes-fail.ts'));
    expect(expectedLines('writes-fail.ts').length).toBe(17);
  });
  it('writes-pass.ts reports nothing', () => {
    expect(lint('writes-pass.ts')).toEqual([]);
  });
  it('only tests and fixtures are exempt', () => {
    expect(isExempt('/x/src/data/rest.test.ts')).toBe(true);
    expect(isExempt('/x/src/data/fixtures/pgmock.ts')).toBe(true);
    expect(isExempt('/x/src/data/live.ts')).toBe(false);
    expect(isExempt('/x/src/data/fixturesish.ts')).toBe(false);
  });
  it('app2/web/src is clean (the real run)', () => {
    const { findings } = run();
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});

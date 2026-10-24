import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { lintQueries } from './query-lint.mjs';

const dir = join(import.meta.dirname, 'fixtures');
const program = (f: string) => ts.createProgram([join(dir, f)], { noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: false });
const expectedLines = (f: string) =>
  readFileSync(join(dir, f), 'utf8').split('\n').flatMap((l, i) => (/\/\/ expect: query-unbounded/.test(l) ? [i + 1] : []));

describe('query-unbounded', () => {
  it('fail.ts reports exactly its // expect lines', () => {
    const got = lintQueries(program('fail.ts'), { root: dir });
    expect(got.every((f) => f.rule === 'query-unbounded' && f.severity === 'error')).toBe(true);
    expect(got.map((f) => f.line)).toEqual(expectedLines('fail.ts'));
    expect(expectedLines('fail.ts').length).toBe(4);
  });
  it('pass.ts reports nothing', () => {
    expect(lintQueries(program('pass.ts'), { root: dir })).toEqual([]);
  });
});

// Types for query-lint.mjs (plain JS so the lint runs with bare `node`).
import type ts from 'typescript';
import type { Finding } from '../design-lint/allow.mjs';
export declare function lintQueries(program: ts.Program, opts?: { root?: string; jsonEntries?: Map<string, unknown[]>; exclude?: (fileName: string) => boolean }): Finding[];
export declare function programFor(tsconfig: string): ts.Program;
export declare function run(opts?: { root?: string; allowJson?: string }): { programs: number; files: number; findings: Finding[] };

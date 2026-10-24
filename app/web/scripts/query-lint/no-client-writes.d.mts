// Types for no-client-writes.mjs (plain JS so the lint runs with bare `node`).
import type ts from 'typescript';
import type { Finding } from '../design-lint/allow.mjs';
export declare const RULE: 'no-client-writes';
export declare function isExempt(fileName: string): boolean;
export declare function lintWrites(program: ts.Program, opts: { root: string; include: (fileName: string) => boolean; exempt?: (fileName: string) => boolean }): Finding[];

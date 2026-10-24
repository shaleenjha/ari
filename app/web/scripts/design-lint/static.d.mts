// Types for static.mjs.
import type { Finding } from './allow.mjs';
export type { Finding };
type Opts = { jsonEntries?: Map<string, { rule: string; reason?: string; used: boolean }[]>; vars?: Map<string, string> };
import type { TokenPair } from './rules.mjs';
export declare const STATIC_RULES: Set<string>;
export declare function lintSource(file: string, text: string, opts?: Opts): Finding[];
export declare function lintCssFile(file: string, text: string, opts?: Opts): Finding[];
export declare function lintHtmlCopy(file: string, html: string, opts?: Opts): Finding[];
export declare function lintManifestCopy(file: string, json: string, opts?: Opts): Finding[];
export declare function lintTokens(tokensCss: string, mirrors: [string, string][]): { pairs: TokenPair[]; findings: Finding[] };
export declare function run(root?: string, opts?: { allowJson?: string }): { files: number; findings: Finding[]; pairs: TokenPair[] };

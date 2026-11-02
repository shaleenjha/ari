// Types for allow.mjs.
export type Finding = { file: string; line: number; col: number; rule: string; match: string; text: string; severity: 'error' | 'warning'; kind?: string };
export type InlineAllow = { line: number; col: number; rule: string; reason: string; problem: string | null; used: boolean };
export declare const WEB_ROOT: string;
export declare const REPO_ROOT: string;
export declare const ALLOW_JSON: string;
export declare function parseInlineAllows(text: string): InlineAllow[];
export declare function loadAllowJson(path?: string, webRoot?: string): { entries: Map<string, { rule: string; reason: string; used: boolean }[]>; problems: Finding[] };
export declare function allowIndex(file: string, text: string, jsonEntries?: Map<string, { rule: string; used: boolean }[]>): {
  inline: InlineAllow[];
  suppress(rule: string, line: number): boolean;
  problems(ownRules: Set<string>, opts?: { reportInvalid?: boolean }): Finding[];
};
export declare function finding(file: string, line: number, col: number, rule: string, match: string, text: string, severity?: 'error' | 'warning'): Finding;
export declare function staleJsonEntries(entries: Map<string, { rule: string; used: boolean }[]>, ownRules: Set<string>): Finding[];
export declare function printFindings(findings: Finding[], opts: { label: string; okLine: string; kind?: (f: Finding) => string }): number;

export type Finding = { file: string; line: number; rule: string; match: string; text: string };
export declare function lintSource(file: string, text: string): Finding[];
export declare function lintHtmlCopy(file: string, html: string): Finding[];
export declare function lintManifestCopy(file: string, json: string): Finding[];
export declare function run(root?: string): { files: number; findings: Finding[] };

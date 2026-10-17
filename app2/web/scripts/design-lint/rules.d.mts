// Types for rules.mjs (kept as plain JS so the static lint runs with bare `node`, no build step).
export declare const MIN_TAP: number;
export declare const TODAY_MAX_VIEWPORTS: number;
export declare const WIDTHS: number[];
export declare const EFFECTS_ALLOW_LIST: string[];
export type Hit = { rule: string; match: string };
export declare function checkText(text: string, opts: { copy: boolean }): Hit[];
export declare function firstFamily(list: string): string;
export declare function isSystemFamily(family: string): boolean;
export declare function declarations(css: string): { prop: string; value: string; line: number }[];
export declare function familyFromShorthand(value: string): string | null;
export declare function lintCss(css: string, opts: { allowEffects: boolean }): { rule: string; line: number; match: string }[];
export declare function isGlow(value: string): boolean;
export declare function luminance(rgb: [number, number, number]): number;
export declare function contrast(a: [number, number, number], b: [number, number, number]): number;
export declare function isLargeText(px: number, weight: number): boolean;
export declare function requiredRatio(px: number, weight: number): number;

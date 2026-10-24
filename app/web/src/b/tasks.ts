// "Ask Ari" (demo only): split what a rep types into separate tasks. Pure, so it is unit tested (tasks.test.ts).

/** Split on new lines, sentence ends, semicolons and " and then " / " then " / " also ". Trims, drops empties, caps each at 140 chars. */
export function splitTasks(text: string): string[] {
  return text
    .split(/\n+|(?<=[.?])\s+|;\s*|\s+(?:and then|then|also)\s+/i)
    .map((t) => t.trim().replace(/[.;,]+$/, '').trim())
    .filter((t) => t.length > 1)
    .map((t) => (t.length > 140 ? `${t.slice(0, 139)}…` : t))
    .map((t) => t[0]!.toUpperCase() + t.slice(1));
}

// gmail-ingest handler: messages -> parsed events -> matched -> ingest_events rows.
// SHADOW mode (default): rows are written with mode='shadow' and nothing else changes. A nightly diff compares them with
// what the current worker recorded; after 3 clean days the mode flips to 'live', where an accept/reply row also calls
// app.person_mark (as the workspace's agent member) and an unmatched one creates a "Who is this?" task (status proposed).
import { parseLinkedInEmail, type RawEmail, type ParsedEvent } from './parse';
import { matchPerson, type Candidate, type MatchMethod } from './match';

export interface IngestRow {
  workspaceId: string; sourceMsgId: string; kind: ParsedEvent['kind']; parsed: ParsedEvent;
  matchedPersonId?: string; matchMethod: MatchMethod; mode: 'shadow' | 'live'; receivedAt: string;
}
export interface IngestSideEffect { type: 'person_mark' | 'who_is_this'; personId?: string; field?: 'accepted' | 'replied'; at: string; candidates?: string[] }

export function ingest(workspaceId: string, msgs: RawEmail[], people: Candidate[], mode: 'shadow' | 'live' = 'shadow',
  seen: Set<string> = new Set()): { rows: IngestRow[]; effects: IngestSideEffect[] } {
  const rows: IngestRow[] = []; const effects: IngestSideEffect[] = [];
  for (const m of msgs) {
    if (seen.has(m.id)) continue;                       // idempotent on Gmail message id
    seen.add(m.id);
    const ev = parseLinkedInEmail(m);
    if (ev.kind === 'unknown' && ev.reason === 'not_from_linkedin') continue;
    const mt = ev.kind === 'accept' || ev.kind === 'reply' ? matchPerson(ev, people) : { method: 'none' as const, candidates: [] };
    rows.push({ workspaceId, sourceMsgId: m.id, kind: ev.kind, parsed: ev, matchedPersonId: mt.personId, matchMethod: mt.method, mode, receivedAt: ev.at });
    if (mode === 'live' && (ev.kind === 'accept' || ev.kind === 'reply')) {
      effects.push(mt.personId
        ? { type: 'person_mark', personId: mt.personId, field: ev.kind === 'accept' ? 'accepted' : 'replied', at: ev.at }
        : { type: 'who_is_this', at: ev.at, candidates: mt.candidates });
    }
  }
  return { rows, effects };
}

/** Nightly shadow diff: what the parser saw vs what the current worker recorded (person id -> event time). */
export function shadowDiff(rows: IngestRow[], recorded: Map<string, { accepted?: string; replied?: string }>) {
  const missing: string[] = []; const extra: string[] = []; const unmatched = rows.filter((r) => (r.kind === 'accept' || r.kind === 'reply') && !r.matchedPersonId).length;
  for (const r of rows) {
    if (!r.matchedPersonId || (r.kind !== 'accept' && r.kind !== 'reply')) continue;
    const rec = recorded.get(r.matchedPersonId);
    if (!(r.kind === 'accept' ? rec?.accepted : rec?.replied)) extra.push(`${r.kind}:${r.matchedPersonId}`);
  }
  for (const [pid, rec] of recorded) {
    if (rec.accepted && !rows.some((r) => r.kind === 'accept' && r.matchedPersonId === pid)) missing.push(`accept:${pid}`);
  }
  return { agree: missing.length === 0 && extra.length === 0, missing, extra, unmatched };
}

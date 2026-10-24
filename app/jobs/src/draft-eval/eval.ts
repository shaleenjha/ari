// Quill: draft-engine evaluation harness. Runs a DraftEngine over synthetic personas, scores each draft with scoreDraft, and
// checks the scorer itself against a labelled synthetic corpus. Runs in CI (npm run eval:drafts) with the deterministic
// baseline engine; an LLM engine plugs into the same interface offline (cost-recorded), never against real prospects.
import { scoreDraft, type StyleScore } from './style';
import { PERSONAS, LABELLED, type Persona } from './synthetic';

export interface DraftEngine { name: string; draft(p: Persona): Promise<string> | string }
export interface EvalRow { personaId: string; body: string; result: StyleScore }
export interface EvalReport {
  schema: 'ari.draft-eval/v1'; engine: string; n: number; passRate: number; meanScore: number;
  byRule: Record<string, number>; rows: EvalRow[];
  scorer: { labelled: number; agreement: number; falsePass: string[]; falseFail: string[] };
}
export interface Thresholds { minPassRate: number; minMeanScore: number; minScorerAgreement: number }
export const DEFAULT_THRESHOLDS: Thresholds = { minPassRate: 0.9, minMeanScore: 85, minScorerAgreement: 1 };

/** Deterministic baseline: what the engine must at least match. One line, names the trigger, one soft ask. */
export const baselineEngine: DraftEngine = {
  name: 'baseline-template-v1',
  draft: (p) => `Hi ${p.firstName}, saw ${p.company} ${p.trigger}. Worth a short chat on how teams keep ${p.dataKind} out of app databases?`,
};

export function checkScorer() {
  const falsePass: string[] = []; const falseFail: string[] = [];
  for (const c of LABELLED) {
    const r = scoreDraft(c.body, { firstName: c.firstName, company: c.company });
    if (r.pass && !c.good) falsePass.push(c.id);
    if (!r.pass && c.good) falseFail.push(c.id);
  }
  return { labelled: LABELLED.length, agreement: (LABELLED.length - falsePass.length - falseFail.length) / LABELLED.length, falsePass, falseFail };
}

export async function evaluate(engine: DraftEngine, personas: Persona[] = PERSONAS): Promise<EvalReport> {
  const rows: EvalRow[] = [];
  for (const p of personas) {
    const body = await engine.draft(p);
    rows.push({ personaId: p.id, body, result: scoreDraft(body, { firstName: p.firstName, company: p.company }) });
  }
  const byRule: Record<string, number> = {};
  for (const r of rows) for (const v of r.result.violations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  const n = rows.length;
  return { schema: 'ari.draft-eval/v1', engine: engine.name, n, passRate: rows.filter((r) => r.result.pass).length / n,
    meanScore: rows.reduce((s, r) => s + r.result.score, 0) / n, byRule, rows, scorer: checkScorer() };
}

export function gate(r: EvalReport, t: Thresholds = DEFAULT_THRESHOLDS): string[] {
  const fails: string[] = [];
  if (r.passRate < t.minPassRate) fails.push(`pass rate ${(r.passRate * 100).toFixed(0)}% < ${t.minPassRate * 100}%`);
  if (r.meanScore < t.minMeanScore) fails.push(`mean score ${r.meanScore.toFixed(1)} < ${t.minMeanScore}`);
  if (r.scorer.agreement < t.minScorerAgreement) fails.push(`scorer agreement ${(r.scorer.agreement * 100).toFixed(0)}% (false pass ${r.scorer.falsePass.join(',') || '-'}; false fail ${r.scorer.falseFail.join(',') || '-'})`);
  return fails;
}

export function renderEval(r: EvalReport): string {
  const out = [`# Draft eval: ${r.engine} (${r.schema})`, `drafts ${r.n} · pass ${(r.passRate * 100).toFixed(0)}% · mean ${r.meanScore.toFixed(1)} · scorer agreement ${(r.scorer.agreement * 100).toFixed(0)}% on ${r.scorer.labelled} labelled`, '',
    '| persona | score | pass | violations |', '|---|---|---|---|'];
  for (const x of r.rows) out.push(`| ${x.personaId} | ${x.result.score} | ${x.result.pass ? 'yes' : 'no'} | ${x.result.violations.map((v) => `${v.rule}:${v.detail}`).join('; ')} |`);
  return out.join('\n');
}

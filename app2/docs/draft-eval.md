# Quill: draft-engine evaluation harness (Phase 1, synthetic only)

Ari's drafting engine is judged by code before any model or prompt change ships. No real prospect, account or DM is used:
personas and the labelled corpus are invented (`jobs/src/drafts/synthetic.ts`).

| Piece | Where |
|---|---|
| Style scorer (deterministic): 1 to 2 lines, ≤ 300 chars (works as a connection note), no em/en/figure dashes or a spaced hyphen used as one, no hedging (whole-word list), no banned phrases, no unfilled placeholders = hard gates; > 1 question, not naming the person or company, stiff opener, > 1 "!" = soft costs | `jobs/src/drafts/style.ts` |
| Harness: `DraftEngine` interface, baseline engine, `evaluate()` → report `ari.draft-eval/v1` (pass rate, mean score, violations by rule), scorer self-check against 14 labelled drafts, `gate()` thresholds (pass ≥ 90 %, mean ≥ 85, scorer agreement 100 %) | `jobs/src/drafts/eval.ts` |
| CI | job `drafts-eval` runs `npm run eval:drafts` (vitest, prints the report) |

## How Quill uses it
- A new engine (prompt or model) implements `DraftEngine` and runs `evaluate()` offline on the synthetic personas; the LLM run records model, tokens, cost and prompt hash like every agent job. It ships only if it clears `gate()` and beats the baseline's mean.
- Style learning from Owner's edits (draft_revisions) becomes new labelled cases: an edit that removed a phrase adds that phrase to a rule or a labelled bad example, so the scorer tracks the house style as it moves.
- The harness never scores or stores real prospect DMs; drafting for real people happens only inside Ari's own jobs.

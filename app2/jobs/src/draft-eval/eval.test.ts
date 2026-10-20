import { describe, expect, it } from 'vitest';
import { scoreDraft } from './style';
import { baselineEngine, checkScorer, evaluate, gate, renderEval, type DraftEngine } from './eval';

describe('scoreDraft (DM house style)', () => {
  it('passes a 1 to 2 line, personal, plain draft', () => {
    expect(scoreDraft('Hi Avery, saw the residency hire at Exquorra Pay. Open to a short chat?', { firstName: 'Avery' })).toMatchObject({ pass: true, score: 100 });
  });
  it('hard-fails dashes (em, en, spaced hyphen) but allows hyphenated words', () => {
    for (const d of ['a \u2014 b', 'a\u2013b', 'a - b']) expect(scoreDraft(`Hi Avery, ${d}. Chat?`).violations.map((v) => v.rule)).toContain('dash');
    expect(scoreDraft('Hi Avery, the de-identification work looks strong. Chat?').violations).toEqual([]);
  });
  it('flags hedging as whole words only', () => {
    expect(scoreDraft('Hi Avery, I think it could just help.').violations.filter((v) => v.rule === 'hedge').map((v) => v.detail)).toEqual(['just', 'i think']);
    expect(scoreDraft('Hi Avery, justice tech is a fun space. Chat?').violations).toEqual([]);
  });
  it('lines, length, placeholders, asks', () => {
    expect(scoreDraft('a\nb\nc').pass).toBe(false);
    expect(scoreDraft('x'.repeat(301)).violations[0]!.rule).toBe('length');
    expect(scoreDraft('Hi [First Name], chat?').violations.map((v) => v.rule)).toContain('placeholder');
    expect(scoreDraft('Hi Avery, chat? Tuesday?').violations.map((v) => v.rule)).toEqual(['asks']);
  });
});

describe('eval harness', () => {
  it('the scorer agrees with every labelled synthetic draft', () => {
    const s = checkScorer(); console.log(JSON.stringify(s));
    expect(s).toMatchObject({ agreement: 1, falsePass: [], falseFail: [] });
  });
  it('baseline engine clears the CI gate', async () => {
    const r = await evaluate(baselineEngine);
    console.log(renderEval(r));
    expect(gate(r)).toEqual([]);
    expect(r.n).toBe(8);
    expect(renderEval(r)).toContain('baseline-template-v1');
  });
  it('a regressing engine (dashes, hedges, three lines) fails the gate', async () => {
    const bad: DraftEngine = { name: 'bad', draft: (p) => `Hi ${p.firstName} \u2014 just wondering if ${p.company} might be open?\nMaybe?\nThanks!` };
    const r = await evaluate(bad);
    expect(r.passRate).toBe(0);
    expect(gate(r).length).toBeGreaterThan(0);
    expect(r.byRule).toMatchObject({ dash: 8, lines: 8 });
  });
});

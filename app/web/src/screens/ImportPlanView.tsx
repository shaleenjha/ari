// The import plan on screen (spec 08): clean adds as one count, each flag as one plain line with its prepared fix
// preselected and the other fixes one tap away, then one key with the plan's label. The key never writes: applying the
// plan is stage S3 Diamond (data/imports.ts applyImportPlan, a stub that saves nothing).
import { memo, useCallback, useId, useState } from 'react';
import { approveLabelFor, chosenKey, confidenceText, defaultChoices, type Choices, type Flag, type ImportPlan } from '../data/importPlan';
import { applyImportPlan } from '../data/imports';
import { Icon } from '../ui/Icon';
import { tick } from '../ui/haptics';

const OFF_LINE = 'Adding is not on yet. Nothing is saved.';
const TAPPED_LINE = 'Nothing was added. Adding from a file comes in a later build.';

/** One flag. Memoised: a choice on one row re-renders that row only (up to 100 rows). */
const FlagRow = memo(function FlagRow({ f, fi, pick, onPick }: { f: Flag; fi: number; pick: number; onPick: (fi: number, oi: number) => void }) {
  const group = useId();
  const quiet = [confidenceText(f.confidence), f.source].filter(Boolean).join(' · ');
  const parked = chosenKey(f, pick) === 'park_no_linkedin';
  return (
    <li className="row col imp-flag" data-testid={`flag-${f.row}`}>
      <b className="imp-detail">{f.detail}</b>
      {quiet && <span className="imp-quiet" data-testid={`flag-${f.row}-source`}>{quiet}</span>}
      <fieldset className="imp-opts">
        <legend className="sr-only">Fix for {f.name}</legend>
        {f.options.map((o, i) => (
          <label key={`${o.key}-${i}`} className={i === pick ? 'btn opt imp-opt on' : 'btn opt imp-opt'}>
            <input className="imp-hit" type="radio" name={group} checked={i === pick} onChange={() => onPick(fi, i)} onClick={() => tick(4)} />
            <Icon name="check" size={16} className="imp-mark" />
            <span className="imp-optlabel">{o.label}</span>
          </label>
        ))}
      </fieldset>
      {parked && f.searchUrl && (
        <a className="btn text imp-search" href={f.searchUrl} target="_blank" rel="noopener noreferrer"
          aria-label={`Search for ${f.name}'s LinkedIn profile, opens a new tab`} data-testid={`flag-${f.row}-search`} onClick={() => tick(8)}>
          <span>Search</span><Icon name="open-link" size={16} />
        </a>
      )}
    </li>
  );
});

export function ImportPlanView({ plan }: { plan: ImportPlan }) {
  // Prepared defaults first. Parent remounts this view (key) for each new plan, so choices never carry across files.
  const [choices, setChoices] = useState<Choices>(() => defaultChoices(plan));
  const [tapped, setTapped] = useState(false);
  const label = approveLabelFor(plan, choices);
  const pick = useCallback((fi: number, oi: number) => setChoices((c) => c.map((x, j) => (j === fi ? oi : x))), []);
  const approve = async () => {
    const r = await applyImportPlan(plan, choices);
    if (!r.applied) setTapped(true);
  };
  return (
    <div data-testid="import-plan">
      <p className="card imp-adds" data-testid="import-adds">
        <b>{plan.add.length} ready to add</b><span className="n">{plan.add.length === 1 ? 'row has' : 'rows have'} a name, company and LinkedIn URL</span>
      </p>
      {plan.flags.length > 0 && (
        <>
          <h2 className="sub">To check · {plan.flags.length}</h2>
          <ul className="rows" data-testid="import-flags">
            {plan.flags.map((f, i) => <FlagRow key={`${f.kind}-${f.row}`} f={f} fi={i} pick={choices[i] ?? 0} onPick={pick} />)}
          </ul>
        </>
      )}
      {plan.notes.length > 0 && (
        <ul className="imp-notes" data-testid="import-notes">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      )}
      <div className="imp-approve">
        <button type="button" className="btn fill key" aria-disabled="true" aria-describedby="imp-off" data-testid="import-approve"
          onClick={() => { void approve(); }}>
          <span>{label}</span>
        </button>
        <p className="muted" id="imp-off" role="status" data-testid="import-off">{tapped ? TAPPED_LINE : OFF_LINE}</p>
      </div>
    </div>
  );
}

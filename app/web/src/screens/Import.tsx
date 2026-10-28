// Import a CSV (spec 08). Pick a file on the phone, read it here (data/importPlan.ts), ask Ari to check it
// (import_resolve, through data/imports.ts), and show the prepared plan. Nothing on this screen writes.
import { useRef, useState, type ChangeEvent } from 'react';
import { fitsOneRequest, MAX_IMPORT_ROWS, parseImportCsv, type ImportPlan, type ParsedCsv } from '../data/importPlan';
import { ImportResolveError, importResolver, RESOLVE_ERROR_LINE } from '../data/imports';
import { Icon } from '../ui/Icon';
import { ImportPlanView } from './ImportPlanView';

/** Bigger than any 100 row export; anything larger is not a lead list. */
const MAX_FILE_BYTES = 2_000_000;

type State =
  | { at: 'idle' }
  | { at: 'error'; line: string; file?: string }
  | { at: 'checking'; file: string; parsed: ParsedCsv }
  | { at: 'plan'; file: string; parsed: ParsedCsv; plan: ImportPlan; n: number }
  | { at: 'failed'; file: string; parsed: ParsedCsv; line: string };

const rowsWord = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

function FileFacts({ file, parsed }: { file: string; parsed: ParsedCsv }) {
  return (
    <div className="imp-facts" data-testid="import-facts">
      <p className="muted"><b className="imp-file">{file}</b> · {rowsWord(parsed.rows.length)} to check</p>
      {parsed.capped && <p className="muted" data-testid="import-capped">The file has {parsed.usable} rows. Ari checks the first {MAX_IMPORT_ROWS}. Put the rest in another file.</p>}
      {parsed.skipped > 0 && <p className="muted" data-testid="import-skipped">{rowsWord(parsed.skipped)} skipped: no name or company.</p>}
    </div>
  );
}

export function Import() {
  const resolve = importResolver();
  const [s, setS] = useState<State>({ at: 'idle' });
  const run = useRef(0);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';                       // picking the same file again still fires change
    if (!f || !resolve) return;
    const me = ++run.current;
    if (f.size > MAX_FILE_BYTES) { setS({ at: 'error', file: f.name, line: 'This file is too big for a lead list. Use a CSV under 2 MB.' }); return; }
    let text: string;
    try { text = await f.text(); } catch { setS({ at: 'error', file: f.name, line: 'Could not read this file. Save it as CSV and pick it again.' }); return; }
    const parsed = parseImportCsv(text);
    if (parsed.error) { setS({ at: 'error', file: f.name, line: parsed.error }); return; }
    if (!fitsOneRequest(parsed.rows)) { setS({ at: 'failed', file: f.name, parsed, line: RESOLVE_ERROR_LINE.too_large }); return; }
    setS({ at: 'checking', file: f.name, parsed });
    try {
      const plan = await resolve(parsed.rows);
      if (me === run.current) setS({ at: 'plan', file: f.name, parsed, plan, n: me });
    } catch (err) {
      if (me === run.current) setS({ at: 'failed', file: f.name, parsed, line: RESOLVE_ERROR_LINE[err instanceof ImportResolveError ? err.code : 'failed'] });
    }
  };

  const busy = s.at === 'checking';
  return (
    <section aria-labelledby="h-imp" aria-busy={busy}>
      <header className="hd"><a href="#/report" className="back" aria-label="Back"><Icon name="chevron-right" /></a><h1 id="h-imp">Import</h1></header>
      <p className="muted">A CSV with name and company columns. Title, location and LinkedIn URL are used when present. Up to {MAX_IMPORT_ROWS} rows.</p>
      {!resolve ? (
        <p className="muted" role="status" data-testid="import-unavailable">Checking a file is not on in this build yet.</p>
      ) : (
        <label className={busy ? 'btn center imp-pick is-busy' : 'btn center imp-pick'} data-testid="import-pick">
          <input className="imp-hit" type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => { void onFile(e); }} data-testid="import-file" />
          <span>{s.at === 'idle' ? 'Choose a CSV file' : 'Choose another file'}</span>
        </label>
      )}
      <div aria-live="polite">
        {s.at === 'error' && <p className="muted" role="alert" data-testid="import-error">{s.file ? <><b className="imp-file">{s.file}</b> · </> : null}{s.line}</p>}
        {(s.at === 'checking' || s.at === 'plan' || s.at === 'failed') && <FileFacts file={s.file} parsed={s.parsed} />}
        {s.at === 'checking' && <p className="muted" data-testid="import-checking">Checking {rowsWord(s.parsed.rows.length)}.</p>}
        {s.at === 'failed' && <p className="muted" role="alert" data-testid="import-failed">{s.line}</p>}
      </div>
      {s.at === 'plan' && <ImportPlanView key={s.n} plan={s.plan} />}
    </section>
  );
}

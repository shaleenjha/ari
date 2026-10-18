import { hhmm } from './useAsync';

/** Quiet line while a screen shows its last good copy because a read failed for now (offline, retrying). */
export const Stale = ({ at }: { at?: number }) => (at ? <p className="muted" role="status" data-testid="stale">Updated {hhmm(at)}. Retrying.</p> : null);

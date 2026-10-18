import { hma } from './readStore';

/** One quiet line while a screen keeps what it loaded because reads are failing for lack of network. Clears on success. */
export const Stale = ({ at }: { at?: number }) => (at
  ? <p className="muted" role="status" data-testid="stale">Offline. Showing what loaded at {hma(at)}.</p>
  : null);

import { hma } from './readStore';
import { useSession } from './session';

/**
 * The one offline line. While a screen keeps what it loaded because reads are failing for lack of network: "Offline.
 * Showing what loaded at [time]." Otherwise, while sign-in refresh is retrying: "Offline. Retrying." Never both.
 */
export const Stale = ({ at }: { at?: number }) => {
  const s = useSession();
  if (at) return <p className="muted" role="status" data-testid="stale">Offline. Showing what loaded at {hma(at)}.</p>;
  return s.live && s.retrying ? <p className="muted" role="status" data-testid="retrying">Offline. Retrying.</p> : null;
};

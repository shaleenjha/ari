import { hma } from './readStore';
import { useSession } from './session';
import { Icon } from './Icon';

/**
 * The one offline line (S2: facts only, the offline icon at 16). While a screen keeps what it loaded because reads are
 * failing for lack of network: "Offline · loaded [time]". Otherwise, while sign-in refresh is retrying: "Offline ·
 * retrying". Never both.
 */
export const Stale = ({ at }: { at?: number }) => {
  const s = useSession();
  if (at) return <p className="muted offline-line" role="status" data-testid="stale"><Icon name="offline" size={16} /><span>Offline · loaded {hma(at)}</span></p>;
  return s.live && s.retrying ? <p className="muted offline-line" role="status" data-testid="retrying"><Icon name="offline" size={16} /><span>Offline · retrying</span></p> : null;
};

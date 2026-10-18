// Fixed-geometry placeholders. Each one uses the same classes, paddings and line boxes as the element it stands in for, so
// the loaded screen lands in the same space. Bars only: no text, no gradients; a soft pulse only when motion is allowed.

/** One text line box at the parent's font size and line height, with a bar inside. */
const Line = ({ w, as: T = 'span' }: { w: string; as?: 'span' | 'b' }) => <T className="skelline"><i className="bar" style={{ width: w }} /></T>;

/** A Today queue row: same .row box and the two lines of its link (title, status). */
export const SkelRow = ({ w = '62%' }: { w?: string }) => (
  <li className="row skel" aria-hidden="true"><div className="rowbox"><Line as="b" w={w} /><Line w="24%" /></div></li>
);

/** A single line card, like the reply pin. */
export const SkelCard = () => (
  <div className="card skel" aria-hidden="true"><Line as="b" w="40%" /><Line w="22%" /></div>
);

/** A "Who is this?" card at the height the last one rendered on this device. */
export const SkelWho = ({ px }: { px: number }) => (
  <div className="card col who skel" aria-hidden="true" style={{ height: px }}><Line as="b" w="34%" /><Line w="70%" /></div>
);

/** A reply row: one quote line and the two action buttons. */
export const SkelReply = () => (
  <li className="row col skel" aria-hidden="true">
    <p className="quote skelline"><i className="bar" style={{ width: '80%' }} /></p>
    <div className="acts"><div className="btn skelbtn" style={{ width: 150 }} /><div className="btn ghost skelbtn" style={{ width: 100 }} /></div>
  </li>
);

/** Screen readers hear one line while the placeholders show. */
export const Busy = ({ label }: { label: string }) => <p className="sr-only" role="status">{label}</p>;

/** The collapsed "Tidy up" card: one 48px header line inside the card padding. */
export const SkelTidy = () => (
  <div className="card col skel" aria-hidden="true"><div className="cardhead"><Line as="b" w="30%" /><Line w="20%" /></div></div>
);

/** The reply pin: a single line card with the pin border width. */
export const SkelPin = () => (
  <div className="card pin skel" aria-hidden="true"><Line as="b" w="40%" /><Line w="22%" /></div>
);

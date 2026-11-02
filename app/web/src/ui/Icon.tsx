// S2 icons: one <use> into the sprite that vite.config.ts inlines into index.html. currentColor only; the amber index dot
// is the one fill and comes from var(--accent) inside the sprite. Every state icon ships with its word next to it.
export type IconName = 'signal' | 'copy' | 'open-link' | 'send' | 'check' | 'done' | 'ready' | 'waiting' | 'on-hold' | 'friction'
  | 'tidy-up' | 'offline' | 'refresh' | 'chevron-right' | 'delta-up' | 'delta-down' | 'nav-today' | 'nav-replies' | 'nav-report';

/** size: 16 chips and states, 20 keys and rows, 24 nav (tokens --icon-s/m/l). */
export const Icon = ({ name, size = 20, className }: { name: IconName; size?: 16 | 20 | 24; className?: string }) => (
  <svg className={`ic ic-${size}${className ? ` ${className}` : ''}`} aria-hidden="true" focusable="false"><use href={`#ari-${name}`} /></svg>
);

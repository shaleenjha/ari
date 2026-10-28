// B+ building blocks: Tabler outline icons from the inlined sprite, chips, avatars, the sheet, switches, steppers, the toast.
import { useEffect, useRef, type ReactNode } from 'react';
import type { ChipTone } from './demo';

export type IconName =
  | 'cards' | 'layout-dashboard' | 'building' | 'chart-bar' | 'chevron-down' | 'chevron-left' | 'chevron-right' | 'copy'
  | 'brand-linkedin' | 'check' | 'x' | 'arrow-back-up' | 'message-circle' | 'clock' | 'send' | 'user-plus' | 'crown'
  | 'hourglass' | 'search' | 'bulb' | 'player-play' | 'mail' | 'bell' | 'shield-lock' | 'download' | 'trash' | 'info-circle'
  | 'lock' | 'file-text' | 'lifebuoy' | 'refresh' | 'plus' | 'minus' | 'logout' | 'device-mobile' | 'brand-google'
  | 'calendar' | 'users' | 'arrow-up' | 'arrow-down' | 'equal' | 'alert-circle' | 'player-stop' | 'list-check' | 'user';

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg className="ic" width={size} height={size} aria-hidden="true" focusable="false"><use href={`#tb-${name}`} /></svg>;
}

export function Chip({ tone, icon, children }: { tone: ChipTone; icon?: IconName; children: ReactNode }) {
  return <span className={`chip chip-${tone}`} data-status={tone}>{icon && <Icon name={icon} size={16} />}<span>{children}</span></span>;
}

export const initials = (name: string) => name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export function Avatar({ name, size = 'm' }: { name: string; size?: 's' | 'm' | 'l' }) {
  return <span className={`av av-${size}`} aria-hidden="true">{initials(name)}</span>;
}

/** A bottom sheet on the native <dialog>: focus is held inside, Escape and the scrim close it. */
export function Sheet({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    document.documentElement.classList.add('locked');
    return () => document.documentElement.classList.remove('locked');
  }, []);
  return (
    <dialog ref={ref} className="sheet" aria-labelledby={`${testId}-t`} data-testid={testId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet-in">
        <header className="sheet-head">
          <h2 id={`${testId}-t`} tabIndex={-1} autoFocus>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => onClose()}><Icon name="x" /></button>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </dialog>
  );
}

export function Switch({ on, label, onChange, hint }: { on: boolean; label: string; onChange: () => void; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="row row-btn" onClick={onChange}>
      <span className="row-main"><span className="row-label">{label}</span>{hint && <span className="row-hint">{hint}</span>}</span>
      <span className={on ? 'sw on' : 'sw'} aria-hidden="true"><span /></span>
    </button>
  );
}

export function Stepper({ label, value, unit, onStep, min, max }: { label: string; value: number; unit: string; onStep: (by: number) => void; min: number; max: number }) {
  return (
    <div className="row" role="group" aria-label={label}>
      <span className="row-main"><span className="row-label">{label}</span><span className="row-hint" aria-live="polite">{value} {unit}</span></span>
      <span className="stepper">
        <button type="button" className="icon-btn ghost" aria-label={`Less, ${label}`} disabled={value <= min} aria-disabled={value <= min} onClick={() => onStep(-1)}><Icon name="minus" /></button>
        <button type="button" className="icon-btn ghost" aria-label={`More, ${label}`} disabled={value >= max} aria-disabled={value >= max} onClick={() => onStep(1)}><Icon name="plus" /></button>
      </span>
    </div>
  );
}

export function Toast({ text, onUndo, onDone }: { text: string; onUndo?: () => void; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [text, onDone]);
  return (
    <div className="toast" role="status" data-testid="toast">
      <span className="toast-text">{text}</span>
      {onUndo && <button type="button" className="toast-undo" onClick={onUndo}><Icon name="arrow-back-up" size={18} />Undo</button>}
    </div>
  );
}

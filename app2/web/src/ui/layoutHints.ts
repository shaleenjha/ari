// The shape of each screen's last loaded result (counts only, never content), kept on this device so the next skeleton
// takes the same space as the data that replaces it. Falls back to memory when the viewer blocks storage.
import { safeStorage } from '../data/auth';

/** who: the rendered height (px) of each "Who is this?" card, since its text wraps by name and headline length. */
export interface TodayHints { pin: boolean; who: number[]; tidy: boolean; queue: number }
export interface RepliesHints { open: number }
export interface Hints { today: TodayHints; replies: RepliesHints }

const KEY = 'ari2-layout';
export const DEFAULT_HINTS: Hints = { today: { pin: false, who: [], tidy: false, queue: 5 }, replies: { open: 3 } };
let store: Storage | null = null;
const st = () => (store ??= safeStorage('localStorage'));

export function readHints(): Hints {
  try {
    const h = JSON.parse(st().getItem(KEY) ?? 'null') as Partial<Hints> | null;
    return { today: { ...DEFAULT_HINTS.today, ...(h?.today ?? {}) }, replies: { ...DEFAULT_HINTS.replies, ...(h?.replies ?? {}) } };
  } catch { return DEFAULT_HINTS; }
}

export function saveHints<K extends keyof Hints>(k: K, v: Hints[K]) {
  try { st().setItem(KEY, JSON.stringify({ ...readHints(), [k]: v })); } catch { /* storage full or blocked: skeleton uses defaults */ }
}

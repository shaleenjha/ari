import { describe, expect, it } from 'vitest';
import { DEFAULT_HINTS, readHints, saveHints } from './layoutHints';

describe('layout hints (placeholder shapes)', () => {
  it('defaults to 5 queue rows, then remembers the last loaded shape per screen', () => {
    expect(readHints()).toEqual(DEFAULT_HINTS);
    saveHints('today', { seen: true, pin: true, who: [262], tidy: true, queue: 3 });
    saveHints('replies', { open: 2 });
    expect(readHints()).toEqual({ today: { seen: true, pin: true, who: [262], tidy: true, queue: 3 }, replies: { open: 2 } });
  });
});

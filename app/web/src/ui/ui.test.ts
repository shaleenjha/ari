import { describe, expect, it } from 'vitest';
import { scrollBehavior, scrollRoot } from './scrollTop';
import { inboxLink, platformOf } from './linkedin';
import { createNotNow } from './notNow';

type N = { name: string; overflowY: string; scrollHeight: number; clientHeight: number; parentElement: N | null };
const node = (name: string, overflowY: string, scrollHeight: number, clientHeight: number, parentElement: N | null): N =>
  ({ name, overflowY, scrollHeight, clientHeight, parentElement });

describe('scroll to top on the current tab', () => {
  const body = node('body', 'visible', 2000, 780, null);
  it('uses the window when nothing between the screen and body scrolls (app today)', () => {
    const shell = node('shell', 'visible', 2000, 2000, body);
    const main = node('main', 'visible', 2000, 2000, shell);
    expect(scrollRoot(main, (n) => n, body)).toBeNull();
  });
  it('finds the screen itself when main.screen is the scroller', () => {
    const shell = node('shell', 'visible', 780, 780, body);
    const main = node('main', 'auto', 2400, 700, shell);
    expect(scrollRoot(main, (n) => n, body)?.name).toBe('main');
  });
  it('finds a scrolling ancestor, and skips scrollers with nothing to scroll', () => {
    const shell = node('shell', 'scroll', 2400, 780, body);
    const main = node('main', 'auto', 500, 500, shell);
    expect(scrollRoot(main, (n) => n, body)?.name).toBe('shell');
  });
  it('is smooth, and instant under reduced motion', () => {
    expect(scrollBehavior(false)).toBe('smooth');
    expect(scrollBehavior(true)).toBe('auto');
  });
});

describe('Copy and open LinkedIn inbox (spec 01)', () => {
  it('picks the platform', () => {
    expect(platformOf('Mozilla/5.0 (Linux; Android 14; Pixel 7)')).toBe('android');
    expect(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios');
    expect(platformOf('Mozilla/5.0 (X11; Linux x86_64)')).toBe('web');
  });
  it('Android uses the intent with an encoded https fallback, iOS the universal link, web a new tab', () => {
    expect(inboxLink('android')).toEqual({ newTab: false,
      href: 'intent://www.linkedin.com/messaging/#Intent;scheme=https;package=com.linkedin.android;S.browser_fallback_url=https%3A%2F%2Fwww.linkedin.com%2Fmessaging%2F;end' });
    expect(inboxLink('ios')).toEqual({ href: 'https://www.linkedin.com/messaging/', newTab: false });
    expect(inboxLink('web')).toEqual({ href: 'https://www.linkedin.com/messaging/', newTab: true });
  });
});

describe('Not now', () => {
  it('sets a reply aside, brings it back, and notifies only on change', () => {
    const s = createNotNow(); let calls = 0; const off = s.subscribe(() => { calls += 1; });
    s.add('r-1'); s.add('r-1');
    expect(s.has('r-1')).toBe(true); expect(calls).toBe(1);
    const before = s.get(); s.remove('r-1');
    expect(s.has('r-1')).toBe(false); expect(before.has('r-1')).toBe(true); expect(calls).toBe(2);
    s.remove('r-1'); off(); s.add('r-2');
    expect(calls).toBe(2);
  });
});

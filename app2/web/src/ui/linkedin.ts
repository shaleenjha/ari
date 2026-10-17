// Copy and open LinkedIn (spec 01). Ari never sends: Owner copies, LinkedIn opens, he sends himself.
// Replies are answered in the LinkedIn inbox (/messaging/). Never window.open.

export type Platform = 'android' | 'ios' | 'web';

export function platformOf(ua: string, maxTouchPoints = 0): Platform {
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios';
  return 'web';
}

const INBOX = 'https://www.linkedin.com/messaging/';

/** Android: intent with the https fallback. iOS: the universal link. Web: the same url in a new tab. */
export function inboxLink(p: Platform): { href: string; newTab: boolean } {
  if (p === 'android') {
    return { href: `intent://www.linkedin.com/messaging/#Intent;scheme=https;package=com.linkedin.android;S.browser_fallback_url=${encodeURIComponent(INBOX)};end`, newTab: false };
  }
  return { href: INBOX, newTab: p === 'web' };
}

/** Opens through an anchor (allowed on every platform by spec 01). The anchor is never attached to the page. */
export function openLink(l: { href: string; newTab: boolean }): void {
  const a = document.createElement('a');
  a.href = l.href;
  if (l.newTab) { a.target = '_blank'; a.rel = 'noopener'; }
  a.click();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

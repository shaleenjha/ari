// Embedded browsers (an app's own link viewer). Google refuses OAuth inside them (403 disallowed_useragent), so live mode
// sends people to their real browser instead of a sign-in that cannot finish. Pure, so it is unit tested.

/** In-app browsers that name themselves in the user agent. */
const IN_APP = /\b(FBAN|FBAV|FB_IAB|FBIOS|Instagram|LinkedInApp|Line\/|MicroMessenger|Twitter|Snapchat|musical_ly|BytedanceWebview|TikTok|Pinterest|KAKAOTALK|GSA\/|Slack)\b/i;

export type Platform = 'android' | 'ios' | 'other';

export function platformOf(ua: string): Platform {
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return 'other';
}

/**
 * True for an embedded WebView: Android `; wv)` (or the old `Version/4.0 Chrome/` WebView form), a named in-app browser, or
 * iOS WKWebView (AppleWebKit without the Safari token). A home screen app on iOS also drops the Safari token, so
 * `standalone` (display-mode standalone / navigator.standalone) is not embedded.
 */
export function isEmbedded(ua: string, standalone = false): boolean {
  if (!ua) return false;
  if (IN_APP.test(ua)) return true;
  const p = platformOf(ua);
  if (p === 'android') return /;\s*wv\)/.test(ua) || /Version\/\d+(\.\d+)* Chrome\/\d/.test(ua);
  if (p === 'ios') return !standalone && /AppleWebKit/i.test(ua) && !/Safari\//.test(ua);
  return false;
}

/** The current page without its hash: the hash router starts at Today after sign-in anyway, and `#` would end an intent URL. */
export const plainUrl = (loc: Pick<Location, 'origin' | 'pathname' | 'search'>): string => `${loc.origin}${loc.pathname}${loc.search}`;

/**
 * Where "Open in browser" goes. Android: an intent that asks for Chrome, with the plain https link as the fallback.
 * iOS: x-safari-https (iOS 17 and later open Safari; older ones ignore it, so Copy link stays next to it). Else the link.
 */
export function externalHref(url: string, p: Platform): string {
  const u = new URL(url);
  if (u.protocol !== 'https:') return url;
  const rest = `${u.host}${u.pathname}${u.search}`;
  if (p === 'android') return `intent://${rest}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
  if (p === 'ios') return `x-safari-https://${rest}`;
  return url;
}

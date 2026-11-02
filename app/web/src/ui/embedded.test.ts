import { describe, expect, it } from 'vitest';
import { externalHref, isEmbedded, platformOf, plainUrl } from './embedded';
import { MemoryStorage, safeStorage } from '../data/auth';

const UA = {
  androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36',
  androidOldWebView: 'Mozilla/5.0 (Linux; Android 9; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/90.0.4430.91 Mobile Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  androidLinkedIn: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 LinkedInApp/4.1',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1',
  iosWebView: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iosInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
};

describe('embedded link viewers', () => {
  it('flags Android WebView, in-app browsers and iOS WKWebView; not real browsers or a home screen app', () => {
    expect(isEmbedded(UA.androidWebView)).toBe(true);
    expect(isEmbedded(UA.androidOldWebView)).toBe(true);
    expect(isEmbedded(UA.androidLinkedIn)).toBe(true);
    expect(isEmbedded(UA.iosWebView)).toBe(true);
    expect(isEmbedded(UA.iosInstagram)).toBe(true);
    expect(isEmbedded(UA.androidChrome)).toBe(false);
    expect(isEmbedded(UA.iosSafari)).toBe(false);
    expect(isEmbedded(UA.iosChrome)).toBe(false);
    expect(isEmbedded(UA.desktop)).toBe(false);
    expect(isEmbedded(UA.iosWebView, true)).toBe(false);
    expect(isEmbedded('')).toBe(false);
  });

  it('opens the page outside: Chrome intent with a plain fallback on Android, x-safari-https on iOS, the link elsewhere', () => {
    const url = plainUrl({ origin: 'https://ari.example.app', pathname: '/', search: '?a=1' });
    expect(url).toBe('https://ari.example.app/?a=1');
    expect(externalHref(url, platformOf(UA.androidWebView)))
      .toBe('intent://ari.example.app/?a=1#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fari.example.app%2F%3Fa%3D1;end');
    expect(externalHref(url, platformOf(UA.iosWebView))).toBe('x-safari-https://ari.example.app/?a=1');
    expect(externalHref(url, 'other')).toBe(url);
    expect(externalHref('http://localhost:4173/', 'android')).toBe('http://localhost:4173/');
  });
});

describe('safeStorage', () => {
  it('falls back to memory when storage throws or is missing, so boot never crashes', () => {
    const throwing = Object.defineProperty({}, 'localStorage', { get() { throw new Error('SecurityError'); } });
    expect(safeStorage('localStorage', throwing)).toBeInstanceOf(MemoryStorage);
    expect(safeStorage('localStorage', { localStorage: null })).toBeInstanceOf(MemoryStorage);
    const real = new MemoryStorage();
    expect(safeStorage('sessionStorage', { sessionStorage: real })).toBe(real);
    const m = new MemoryStorage(); m.setItem('k', 'v');
    expect(m.getItem('k')).toBe('v'); m.removeItem('k'); expect(m.length).toBe(0);
  });
});

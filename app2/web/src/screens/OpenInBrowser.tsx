import { useState } from 'react';
import { externalHref, platformOf, plainUrl } from '../ui/embedded';

/** Copy text without the async clipboard (often missing inside link viewers): a hidden field and execCommand. */
function copyFallback(text: string): boolean {
  const t = document.createElement('textarea');
  t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
  document.body.appendChild(t); t.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  t.remove();
  return ok;
}

/** Live mode inside an app's link viewer: Google sign-in cannot run here, so open the real browser instead. */
export function OpenInBrowser() {
  const url = plainUrl(location);
  const href = externalHref(url, platformOf(navigator.userAgent));
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const copy = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch { ok = copyFallback(url); }
    setCopied(ok ? 'yes' : 'no');
  };
  return (
    <section aria-labelledby="h-wv" className="signin" data-testid="open-in-browser">
      <header className="hd"><h1 id="h-wv">Sign-in needs your browser.</h1></header>
      <p className="muted">Google sign-in does not open inside this app&rsquo;s link viewer. Open Ari in Chrome or Safari to sign in.</p>
      <div className="acts col">
        <a className="btn wide center" href={href} rel="noopener" data-testid="open-external">Open in browser</a>
        <button className="btn ghost wide center" onClick={() => void copy()} data-testid="copy-link">Copy link</button>
      </div>
      <p className="status" role="status" data-testid="copy-status">
        {copied === 'yes' ? 'Link copied. Paste it in your browser.' : copied === 'no' ? `Copy this link: ${url}` : ''}
      </p>
    </section>
  );
}

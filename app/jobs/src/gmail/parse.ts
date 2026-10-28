// gmail-ingest: deterministic parser for LinkedIn notification emails. No LLM.
// Input is a Gmail message reduced to headers + text/html. Output is a typed event or 'unknown' with a reason.
export interface RawEmail {
  id: string;                     // Gmail message id (idempotency key)
  from: string;                   // From header, e.g. 'LinkedIn <invitations@linkedin.com>'
  subject: string;
  date: string;                   // RFC 2822 or ISO; the event time is the email's own time
  text?: string;
  html?: string;
  authResults?: string;           // Authentication-Results header, when present
  snippet?: string;               // Gmail snippet (preheader); accept emails carry the full name only here
}
export type IngestKind = 'accept' | 'reply' | 'invite_sent' | 'unknown';
export interface ParsedEvent {
  sourceMsgId: string;
  kind: IngestKind;
  at: string;                     // ISO timestamp
  name?: string;                  // display name as LinkedIn wrote it
  headline?: string;              // job line when present ("VP Engineering at Ostrevanthe Co")
  company?: string;
  profileUrl?: string;            // canonical https://www.linkedin.com/in/<vanity>
  vanity?: string;
  threadUrl?: string;
  snippet?: string;
  reason?: string;                // why unknown
}

// Spec 04 (Oct 17 2026). Mirrored in scripts/accept_ingest.py: keep the two in step.
const LINKEDIN_FROM = /<?\s*[^<>\s@]+@(?:[a-z0-9-]+\.)*linkedin\.com\s*>?\s*$/i;  // DKIM checked below
export const ACCEPT_SUBJ = [
  /^(.+?),? (?:has )?accepted your (?:LinkedIn )?(?:connection )?invitation\b/i,
  /^You and (.+?) are now connected\b/i, /^(.+?) is now a connection\b/i,
  /^(.+?) (?:a accepté votre invitation|hat Ihre Einladung angenommen|aceptó tu invitación)/i,
];
// "<Name> and other people's connections" (PYMK digest), "<Name>, I'd like to connect" (inbound invite), job alerts "... role - 1 connection"
export const NOT_ACCEPT = /other people.s connections|I.d like to connect|role - \d+ connection/i;
const FULLNAME = /See (.+?)(?:'|’|&#39;)s connections, experience/i;
/** Name as matched against People: credentials after the first comma dropped ("Pat Leesynth, PMP, ITIL" -> "Pat Leesynth"). */
export const coreName = (n: string): string => n.split(',')[0]!.trim();
const REPLY_SUBJ = [/^(.+?) sent you a (?:new )?message/i, /^New message from (.+?)$/i, /^(.+?) just messaged you/i, /^(.+?) replied to your message/i,
  /^Re: .*?\bfrom (.+?)$/i];
const INVITE_SUBJ = [/^You invited (.+?) to connect/i];
const VIA_LINKEDIN = /^"?(.+?)"?\s+via LinkedIn\s*</i;

export function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ');
}
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** Profile URL from any LinkedIn link form: /in/<vanity>, /comm/in/<vanity>, with tracking params, url-encoded. */
export function extractProfile(body: string): { url: string; vanity: string } | undefined {
  const decoded = decodeEntities(body).replace(/%2F/gi, '/').replace(/%3A/gi, ':').replace(/%3F/gi, '?').replace(/%26/gi, '&').replace(/%3D/gi, '=').replace(/%23/gi, '#');
  const m = decoded.match(/https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:comm\/)?in\/([A-Za-z0-9\-_%.]+?)(?:[/?#"'\s<]|$)/i);
  if (!m || !m[1]) return undefined;
  const vanity = decodeURIComponent(m[1]).toLowerCase().replace(/\/$/, '');
  return { url: `https://www.linkedin.com/in/${vanity}`, vanity };
}
export function extractThread(body: string): string | undefined {
  const m = decodeEntities(body).match(/https?:\/\/(?:www\.)?linkedin\.com\/(?:comm\/)?messaging\/thread\/([A-Za-z0-9\-_=%.]+)/i);
  return m ? `https://www.linkedin.com/messaging/thread/${m[1]}` : undefined;
}
const firstMatch = (s: string, res: RegExp[]): string | undefined => {
  for (const r of res) { const m = s.match(r); if (m?.[1]) return m[1].trim(); }
  return undefined;
};
function toIso(d: string): string {
  const t = Date.parse(d);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}
function headlineAfterName(text: string, name: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => l.toLowerCase() === name.toLowerCase());
  const next = i >= 0 ? lines[i + 1] : undefined;
  return next && next.length < 160 && !/linkedin|accept|view|message|unsubscribe/i.test(next) ? next : undefined;
}
function snippetFrom(text: string, name: string, headline?: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^(view|reply|see|unsubscribe|this email|you are receiving|©|linkedin|help|learn why)/i.test(l) && !/https?:\/\//.test(l));
  const i = lines.findIndex((l) => l.toLowerCase().startsWith(name.toLowerCase()));
  const pick = (i >= 0 ? lines.slice(i + 1) : lines).find((l) => l.length > 3 && l.toLowerCase() !== name.toLowerCase() && l !== headline && !/^\S+ (sent you|just messaged)/i.test(l));
  return pick ? pick.slice(0, 280) : undefined;
}
export function companyFromHeadline(h?: string): string | undefined {
  const m = h?.match(/\s(?:at|@)\s+(.+)$/i);
  return m?.[1]?.trim();
}

export function parseLinkedInEmail(e: RawEmail): ParsedEvent {
  const base = { sourceMsgId: e.id, at: toIso(e.date) };
  if (!LINKEDIN_FROM.test(e.from)) return { ...base, kind: 'unknown', reason: 'not_from_linkedin' };
  if (e.authResults && !/dkim=pass[^;]*header\.(?:d|i)=@?(?:[a-z0-9-]+\.)*linkedin\.com/i.test(e.authResults)) {
    return { ...base, kind: 'unknown', reason: 'auth_fail' };
  }
  const body = (e.text ?? '') + '\n' + (e.html ?? '');
  const text = e.text?.trim() ? e.text : htmlToText(e.html ?? '');
  const prof = extractProfile(body);
  const subj = e.subject.trim();

  let name = NOT_ACCEPT.test(subj) ? undefined : firstMatch(subj, ACCEPT_SUBJ);
  if (name) {
    const full = decodeEntities(text + '\n' + (e.snippet ?? '')).match(FULLNAME)?.[1]?.trim();
    if (full && coreName(full).toLowerCase().startsWith(coreName(name).toLowerCase())) name = full;
    name = coreName(name);
    const headline = headlineAfterName(text, name);
    return { ...base, kind: 'accept', name, headline, company: companyFromHeadline(headline), profileUrl: prof?.url, vanity: prof?.vanity };
  }
  name = firstMatch(subj, REPLY_SUBJ) ?? e.from.match(VIA_LINKEDIN)?.[1]?.trim();
  if (name && (firstMatch(subj, REPLY_SUBJ) || /message/i.test(subj))) {
    const headline = headlineAfterName(text, name);
    return { ...base, kind: 'reply', name, headline, company: companyFromHeadline(headline), profileUrl: prof?.url, vanity: prof?.vanity,
      threadUrl: extractThread(body), snippet: snippetFrom(text, name, headline) };
  }
  name = firstMatch(subj, INVITE_SUBJ);
  if (name) return { ...base, kind: 'invite_sent', name, profileUrl: prof?.url, vanity: prof?.vanity };
  return { ...base, kind: 'unknown', reason: 'unrecognised_subject' };
}

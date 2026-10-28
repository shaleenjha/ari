# Ari Relay (board fix #9): LinkedIn replies from Gmail into Supabase `replies`, generic push, 3 one-tap drafts.
# usage (project folder; shell credentials [{"provider":"google","email":"owner@example.com"}]; Supabase as role ari_worker via scripts/ari_db.py):
#   python3 scripts/reply_ingest.py scan [--days N] [--dry]   Gmail LinkedIn message emails since the last scan -> replies rows,
#                                                             people.replied/stage for first replies, one push per reply.
#   python3 scripts/reply_ingest.py backfill [--dry]          people already marked replied with no replies row -> a row (no push)
#   python3 scripts/reply_ingest.py pending                   replies that need drafts, with context, as JSON (for the worker)
#   python3 scripts/reply_ingest.py drafts <reply_id> <f.json> validate and write exactly 3 drafts [{key,label,body}]
#   python3 scripts/reply_ingest.py show                      open replies (what the app pins #1)
# Facts this rests on (checked Oct 16 2026 on 101 LinkedIn message emails, Apr to Oct 2026):
#   * "X just messaged you" digests (messaging-digest-noreply@linkedin.com) carry name, headline, count, profile URL and a
#     thread link, but NOT the message text. Only InMail emails (messages-noreply / hit-reply / inmail-hit-reply) carry text.
#     So snippet_source is 'email' only for InMails; otherwise 'none' and the app asks Owner to paste the text (ari_reply_paste).
#   * The digest arrives when LinkedIn decides the message is unread for a while, so latency = LinkedIn's delay + worker cadence.
#   * Thread links carry login tokens (otpToken, midToken). We store only https://www.linkedin.com/messaging/thread/<id>/.
# Never sends, replies to, labels or modifies email. Never opens LinkedIn.
import sys, os, json, re, html, base64, subprocess, unicodedata, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ari_db import rpc, get  # v18.5: named RPCs only (role ari_worker), no SQL strings

QUERY = ('from:(messaging-digest-noreply@linkedin.com OR messages-noreply@linkedin.com OR hit-reply@linkedin.com '
         'OR inmail-hit-reply@linkedin.com) in:anywhere')
GENERIC = ('New reply on LinkedIn', 'Someone you messaged wrote back. Open Ari to answer.')
BAD = ['\u2014', '\u2013', 'P.S.', 'Reason I reached out', 'Thought this might be relevant', 'Helping companies like yours',
       'Wanted to introduce myself', 'Would love to connect', 'Just bumping this', 'I know this is a top priority', 'transform',
       'revolutionize', 'unlock potential', 'just checking in', 'circling back', 'I hope this finds you well', 'I came across',
       "In today's landscape", "let me know if you're interested", 'leverage', 'utilize', 'streamline', 'robust', 'seamless',
       'game-changer', 'synergy']

def gws(args):
    r = subprocess.run(['gws'] + args, capture_output=True, text=True, timeout=100)
    if r.returncode != 0: raise SystemExit('gws failed: ' + (r.stderr or r.stdout)[-600:])
    return json.loads(r.stdout) if r.stdout.strip() else {}

def parts(p):
    if (p.get('body') or {}).get('data'):
        yield p.get('mimeType'), base64.urlsafe_b64decode(p['body']['data'] + '==').decode('utf8', 'replace')
    for c in p.get('parts') or []: yield from parts(c)

def norm(s):
    s = unicodedata.normalize('NFKD', s or '')
    s = ''.join(ch for ch in s if ch.isalpha() or ch.isspace())
    return ' '.join(s.lower().split())

def slug(url):
    m = re.search(r'linkedin\.com/in/([^/?#\s)]+)', url or '', re.I)
    return m.group(1).lower().rstrip('/') if m else None

def clean_thread(url):
    m = re.search(r'linkedin\.com/(?:comm/)?messaging/thread/([^?\s/]+)', url or '')
    return 'https://www.linkedin.com/messaging/thread/' + m.group(1) + '/' if m else None

def parse(msg):
    """-> list of {name, headline, profile_url, thread_url, snippet} for one LinkedIn message email ([] if not a message)."""
    h = {x['name'].lower(): x['value'] for x in msg['payload']['headers']}
    subj = h.get('subject', '')
    plain = next((t for mt, t in parts(msg['payload']) if mt == 'text/plain'), '')
    if not re.search(r'messaged you|sent new messages|new message|InMail|awaiting response', plain[:400] + subj, re.I): return []
    if re.search(r'waiting for your response|profile views|viewed your profile|Information Technology Rules', subj, re.I): return []
    out = []
    count = re.search(r'(\d+) new messages?', plain[:300])
    for block in re.split(r'\n\s*\.{10,}\s*\n', plain):
        m = re.search(r'^\s*(.+?) \((.*?)\)\s*\n\s*\((https?://[^)\s]+linkedin\.com/in/[^)\s]+)\)', block, re.M)
        if not m: continue
        name, headline, purl = m.group(1).strip(), m.group(2).strip(), m.group(3)
        tm = re.search(r'(https://www\.linkedin\.com/comm/messaging/thread/[^\s]+)', block)
        snip = None
        sm = re.search(r'\nmessage:\s*\n(.*?)\n\s*View message', block, re.S)
        if sm: snip = re.sub(r'\n{3,}', '\n\n', sm.group(1)).strip()[:2000] or None
        out.append({'name': name, 'headline': headline, 'profile_url': purl, 'thread_url': clean_thread(tm.group(1) if tm else ''),
                    'snippet': snip, 'msg_count': int(count.group(1)) if count else None})
    return out

def people_index():
    rows = [r for r in get('people?select=id,name,company,account_id,linkedin_url,review,replied,accepted,connect_sent,dm1_sent'
                           '&deleted_at=is.null&order=id') if (r.get('review') or 'lead') != 'personal']
    by_slug, by_name = {}, {}
    for r in rows:
        s = slug(r['linkedin_url'])
        if s: by_slug[s] = r
        by_name.setdefault(norm(r['name']), []).append(r)
    return by_slug, by_name

def match(item, by_slug, by_name):
    s = slug(item['profile_url'])
    if s and s in by_slug: return by_slug[s], 'profile_url'
    n = norm(re.split(r',', item['name'])[0])
    # name fallback only for people with no LinkedIn URL on file (a different slug means a different person)
    c = [r for r in by_name.get(n, []) if (r['connect_sent'] or r['accepted'] or r['dm1_sent']) and not slug(r['linkedin_url'])]
    return (c[0], 'name') if len(c) == 1 else (None, None)

def scan(days=None, dry=False):
    st = rpc('ari_worker_reply_state')
    since = int(st['scan_last']) if st.get('scan_last') and not days else None
    qq = QUERY + (f' after:{since}' if since else f' newer_than:{days or 2}d')
    lst = gws(['gmail', 'users', 'messages', 'list', '--params', json.dumps({'userId': 'me', 'q': qq, 'maxResults': 100})])
    ids = [m['id'] for m in lst.get('messages') or []]
    seen = set(st.get('seen') or [])
    by_slug, by_name = people_index()
    newest, made, unmatched = since or 0, [], 0
    for mid in ids:
        msg = gws(['gmail', 'users', 'messages', 'get', '--params', json.dumps({'userId': 'me', 'id': mid, 'format': 'full'})])
        ts = int(msg.get('internalDate', '0')) // 1000
        newest = max(newest, ts + 1)
        for it in parse(msg):
            p, how = match(it, by_slug, by_name)
            if not p: unmatched += 1; continue
            key = mid + ':' + (slug(it['profile_url']) or norm(it['name']).replace(' ', '-'))
            if key in seen: continue
            seen.add(key)
            made.append({'person': p['id'], 'name': p['name'], 'how': how, 'snippet': bool(it['snippet']), 'first': p['replied'] is None})
            if dry: continue
            # server side (ari_worker_reply_record): insert on gmail id, push with lock-screen text by the user's pref
            # (generic unless push_show_names), no second push within 6 h, first reply sets people.replied / stage.
            r = rpc('ari_worker_reply_record', {'p_person_id': p['id'], 'p_gmail_id': key,
                    'p_received_at': dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat(), 'p_msg_count': it['msg_count'],
                    'p_thread_url': it['thread_url'], 'p_headline': (it['headline'] or '')[:300], 'p_snippet': it['snippet'],
                    'p_matched_by': how})
            if r and r.get('fresh') and p['replied'] is None: p['replied'] = ts
    if not dry and newest:
        rpc('ari_worker_scan_last_set', {'p_ts': newest})
    print(json.dumps({'emails': len(ids), 'new_replies': made, 'unmatched_senders': unmatched, 'dry': dry}, default=str))

def backfill(dry=False):
    print(json.dumps(rpc('ari_worker_reply_backfill', {'p_dry': dry}), default=str))

def pending():
    print(json.dumps(rpc('ari_worker_replies_pending'), indent=1, default=str, ensure_ascii=False))

def check_drafts(d):
    errs = []
    if not isinstance(d, list) or len(d) != 3: return ['need exactly 3 drafts']
    keys = [i.get('key') for i in d]
    if sorted(keys) != ['answer', 'book', 'soft']: errs.append("keys must be book, answer, soft (one each)")
    for i in d:
        b = (i.get('body') or '').strip()
        if not b or not i.get('label'): errs.append('each draft needs label and body')
        if len(b) > 300: errs.append(f"{i.get('key')}: {len(b)} chars, max 300")
        for w in BAD:
            if w.lower() in b.lower(): errs.append(f"{i.get('key')}: contains {w!r}")
        if b.count('?') > 1: errs.append(f"{i.get('key')}: one ask only")
    return errs

def drafts(rid, path):
    d = json.load(open(path))
    e = check_drafts(d)
    if e: print('NOT WRITTEN:', '; '.join(e)); sys.exit(1)
    d = [{'key': i['key'], 'label': i['label'], 'body': i['body'].strip()} for i in d]
    print(json.dumps([rpc('ari_worker_reply_drafts', {'p_id': int(rid), 'p_drafts': d})], default=str))

def show():
    print(json.dumps(rpc('ari_worker_replies_open', {'p_limit': 20}), indent=1, default=str, ensure_ascii=False))

if __name__ == '__main__':
    a = sys.argv[1:] or ['scan']
    dry = '--dry' in a
    days = int(a[a.index('--days') + 1]) if '--days' in a else None
    if a[0] == 'scan': scan(days, dry)
    elif a[0] == 'backfill': backfill(dry)
    elif a[0] == 'pending': pending()
    elif a[0] == 'drafts': drafts(a[1], a[2])
    elif a[0] == 'show': show()
    else: print(__doc__ if __doc__ else 'see header')

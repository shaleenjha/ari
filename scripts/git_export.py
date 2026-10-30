#!/usr/bin/env python3
"""Keel: build the scrubbed, code-only export of the app for the private git repo.

Copies an allow-list of code files from the project into the export tree,
applies the private scrub map (real names -> the synthetic demo world), then
scans the result. Exits non-zero if anything is found, so nothing unsafe is
ever committed. Two scans run on every exported file:
  1. scripts/repo_scan.py (the same gate CI runs on the repo): secrets, emails,
     phone numbers, real-looking LinkedIn slugs, blocked-name hashes.
  2. The private real-name scan: names.json plus the company and website
     columns of accounts.csv and target_accounts_full.csv (dictionary words
     left out), and every name the scrub map replaces.

The scrub map, the name list and the dictionary live OUTSIDE the repo (in the
private workspace) and must never be committed:
  $KEEL_DIR/scrub_map.json   ordered replacement rules ("rules"), plus per-path rules ("files")
  $KEEL_DIR/names.json       real names pulled read-only from the database
  $KEEL_DIR/dict_words.txt   common English words, never treated as names

Usage: python3 scripts/git_export.py [--refresh-names]
"""
import os, re, sys, csv, json, uuid, shutil, fnmatch, hashlib, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
KEEL = os.environ.get('KEEL_DIR', os.path.join(ROOT, 'work', 'keel'))
OUT = os.environ.get('KEEL_EXPORT', os.path.join(KEEL, 'ari-app'))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import repo_scan

# Allow-list: only these paths are exported. Everything else stays private.
INCLUDE = [
    'web/ops.html', 'web/sw.js', 'web/vercel.json', 'web/build.json',
    'web/ari.webmanifest', 'web/ari-fonts.css', 'web/ari-supabase.js',
    'web/ari-*.png', 'web/kelvarrow-192.png:web/kelvarrow-192.png', 'web/kelvarrow-512.png:web/kelvarrow-512.png', 'web/kelvarrow-192-maskable.png:web/kelvarrow-192-maskable.png', 'web/kelvarrow-512-maskable.png:web/kelvarrow-512-maskable.png', 'web/kelvarrow-apple-180.png:web/kelvarrow-apple-180.png', 'web/kelvarrow-badge-96.png:web/kelvarrow-badge-96.png', 'web/kelvarrow-favicon-64.png:web/kelvarrow-favicon-64.png', 'web/kelvarrow-favicon.svg:web/kelvarrow-favicon.svg', 'web/kyte-*.png', 'web/kyte-favicon.svg', 'web/favicon.ico',  # Oct 29 2026: Kyte icons (v18.14.2)
    'web/ari-*.woff2', 'web/about.html', 'web/privacy.html', 'web/terms.html', 'web/support.html', 'web/accessibility.html',  # served live (Vercel audit V2), S1 R2
    # native/ari/ moved to archive/native-ari-expo-starter/ (PR #7, Oct 21 2026)
    'native/supabase/migrations/*.sql', 'native/supabase/rollbacks/*.sql',
    'native/supabase/pending/*.sql', 'native/supabase/functions/**',  # S1 R2: '*/index.ts' never matched (audit S4)
    'scripts/brief_upsert.py', 'scripts/daily_report.py', 'scripts/db_backup.py',
    'scripts/deploy_web.py', 'scripts/deploy_app2_preview.py', 'scripts/deploy_provenance.py', 'scripts/offsite_certs.py', 'scripts/test_offsite_certs.py', 'scripts/test_book_prune.py', 'scripts/test_log_repair.py', 'scripts/reply_ingest.py',
    'scripts/sync_sheet_supabase.py', 'scripts/git_export.py', 'scripts/git_sync.sh', 'scripts/git_push_api.py', 'scripts/git_pull_remote.py', 'scripts/test_git_sync_pull.py', 'scripts/test_git_push_branch.py',
    'scripts/ari_db.py', 'scripts/backup_check.py', 'scripts/restore_drill.py', 'scripts/offsite_drive.py',
    'scripts/health_check.py', 'scripts/phase0_metrics.py', 'scripts/exec_track_handoff.py', 'scripts/worker_precheck.py', 'scripts/worker_lock.py', 'scripts/draft_tag.py', 'scripts/copy_switch.py', 'scripts/hygiene_scan.py', 'scripts/test_hygiene_scan.py',
    'native/supabase/tests/*.sql', 'native/supabase/tests/*.ts',
    # Phase 1 (Oct 17 2026): app tree + CI, recursive ("dir/**"), build output and deps excluded
    'app/**', '.github/**',
    # Oct 17 2026: specs, app pending migrations, accept ingest
    'docs/specs/*.md', 'docs/engineering/*.md', 'docs/privacy-data-inventory.md', 'docs/RELEASES.md', 'docs/runbooks/*.md', 'native/supabase/migrations/pending/**', 'native/supabase/baseline/*.sql',  # schema-only prod baseline for the sql-prod-shape CI job (Oct 18)
     'scripts/accept_ingest.py', 'scripts/gmail_step.py', 'scripts/test_gmail_step.py', 'docs/specs/worker_step0.txt', 'docs/specs/worker_chat_rule.txt', 'scripts/test_worker_chat_rule.py', 'scripts/scan_heartbeat.py', 'scripts/test_scan_heartbeat.py', 'scripts/copy_check.py', 'scripts/relay_check.py', 'scripts/focus_blocks.py', 'scripts/cadence.py',  # Oct 21 2026: called by the worker task every run, were missing from the repo  # v18.15.4 scan dead-man
    'native/supabase/RESTORE.md', 'native/supabase/pending/MAINTENANCE.md', 'native/supabase/offsite/ari-offsite-recipient*.pem',  # S1 R3: every recipient cert (public only)
    'scripts/ari_token.py', 'scripts/test_ari_token.py', 'native/supabase/ops/*.sql',  # S1 R7 (Oct 21 2026): broker token client (ari_db imports it), its tests, kill switch + read-only inventory SQL
    'repo/README.md:README.md', 'repo/gitignore:.gitignore', 'repo/LICENSE:LICENSE',  # Oct 23 2026: all rights reserved
    # Oct 21 2026 (PR docs/repo-map-renames): plain repo map at the root, and archive/ for retired code kept for reference
    'repo/REPO_MAP.md:REPO_MAP.md', 'archive/**',
    # Oct 24 2026 (scrub build): seller settings (private values stay outside the repo) and the repo leak-scan gate
    'scripts/seller_config.py', 'scripts/repo_scan.py', 'scripts/test_repo_scan.py',
    'scripts/keel_repo.py', 'scripts/keel_repo.conf', 'scripts/test_keel_repo.py',  # Oct 30 2026: the repo name in one line (Kyte rename)
    'scripts/test_ops_sync.js', 'scripts/test_ops_no_story.py',  # Oct 30 2026 v18.14.11: ops.html catch-up + no build story tests
    # Oct 27 2026: ingest labels step 1 (spec docs/specs/09-ingest-labels.md): code labelers + dry-run backfill, and their tests
    'scripts/ingest_labels.py', 'scripts/test_ingest_labels.py',
    'scripts/assumptions.py', 'scripts/test_assumptions.py', 'scripts/assumptions_store.conf',  # Oct 28 2026: G12 draft assumptions (copy_check imports it); the one-line worker switch (off)
    # Oct 24 2026: archive/ui/, old /ops versions and design mockups, scrubbed onto the synthetic data at export time.
    # Left out on purpose (real prospect data that cannot be scrubbed reliably): web/_archive/proto*.html,
    # mockup.html, dossier.html, index.html, ari.html, app.js, and every screenshot (.png).
    'repo/archive-ui-README.md:archive/ui/README.md',
    'web/ops_v1812.html:archive/ui/ops-v18.12.html',
    'web/ops_v1812_6_backup.html:archive/ui/ops-v18.12.6.html',
    'web/_archive/taste.html:archive/ui/design-taste.html',
    'work/ops-simplify-mockup/index.html:archive/ui/ops-simplify-mockup.html',
    'work/ops-simplify-mockup/soft/v2/index.html:archive/ui/ops-simplify-soft-v2.html',
    'work/ari-wallet/index.html:archive/ui/bplus-wallet-mockup.html',
]
BINARY = ('.png', '.woff2', '.jpg', '.ico')
# package-lock files are machine-generated registry metadata: no scrub rules (they would corrupt integrity hashes),
# scanned for secrets only.
GENERATED = ('package-lock.json',)
DATA_URI = repo_scan.DATA_URI


def word_re(w):
    # Capitalised words also match inside camelCase identifiers (onFoo, sendFoo).
    lead = r'(?<![A-Z])' if w[:1].isupper() else r'(?<![A-Za-z])'
    return re.compile(lead + re.escape(w) + r'(?![a-z])')


def proper_re(w):
    # A proper noun in text, never part of a code identifier (quietToast, toast(), _ramp).
    return re.compile(r'(?<![A-Za-z0-9_$])' + re.escape(w) + r'(?![A-Za-z0-9_])')


def _compile(kind, src):
    if kind == 'l':
        return re.compile(re.escape(src))
    if kind == 'p':
        return proper_re(src)
    if kind == 'x':
        return re.compile(src, re.S)
    return word_re(src)


def load_map():
    m = json.load(open(os.path.join(KEEL, 'scrub_map.json')))
    rules = [(_compile(k, s), d, s, k) for k, s, d in m['rules']]
    files = {pat: [(_compile(k, s), d, s, k) for k, s, d in rs] for pat, rs in (m.get('files') or {}).items()}
    return rules, files, set(m.get('ignore', []))


def load_rules():
    return [(rx, d, s) for rx, d, s, _ in load_map()[0]]


def scrub(text, dst, rules, files):
    """Apply the per-path rules, then the global rules, to everything except base64 data URIs (inlined fonts and
    images, which a word rule would corrupt)."""
    rs = [r for pat, lst in files.items() if fnmatch.fnmatch(dst, pat) for r in lst] + rules
    parts = DATA_URI.split(text)
    uris = DATA_URI.findall(text)
    out = []
    for i, chunk in enumerate(parts):
        for rx, rep, _, _ in rs:
            chunk = rx.sub(lambda _m, r=rep: r, chunk)   # literal replacement text
        out.append(chunk)
        if i < len(uris):
            out.append(uris[i])
    return ''.join(out)


# ---------- export-time transforms for files whose demo data is a real snapshot ----------
_FIRST = ['Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Rowan', 'Sasha', 'Emery', 'Finley', 'Harper', 'Indra',
          'Jules', 'Kiran', 'Lane', 'Marlo', 'Noor', 'Oakley', 'Parker', 'Reese', 'Sage', 'Tatum', 'Umi', 'Wren']
_LAST = ['Sampleton', 'Mockley', 'Fakerton', 'Quillova', 'Placeholt', 'Demoreau', 'Fixtura', 'Nullworth', 'Stubridge',
         'Exampleton', 'Pseudova', 'Fauxley', 'Shamwell', 'Dummond', 'Mockett', 'Quillard', 'Decoyne', 'Fictorio']
_COS = ['Quorvelline', 'Ostrevanthe', 'Brennuvia Labs', 'Thessquorn', 'Saffrevane Health', 'Moquadrel', 'Fyndraquel',
        'Exquorra Pay', 'Durnaquill', 'Pyrrhovane', 'Nuvasquell', 'Norquiveth Pay', 'Glimvasse Health', 'Dravequin Systems',
        'Clovardine Labs', 'Quellivarn Insurance', 'Bravossine Health', 'Kelvarrow Labs', 'Marquessine Bank',
        'Orquadrine Systems', 'Tolvessine Pharma', 'Halvenquist Freight', 'Plessivarn Retail']
_TITLES = ['VP Engineering', 'Director, Solutions Engineering', 'Head of Data Platform', 'Senior Director of Engineering',
           'Director of Security', 'Head of AI', 'VP Product', 'Staff Engineer, Privacy']


def _pick(seq, key):
    return seq[int(hashlib.md5(key.encode()).hexdigest(), 16) % len(seq)]


def _synth_person(key):
    first, last = _pick(_FIRST, 'f' + key), _pick(_LAST, 'l' + key)
    return first, '%s %s' % (first, last), 'https://www.linkedin.com/in/%s-%s-example' % (first.lower(), last.lower())


def synth_snapshot(real):
    """Rebuild a read-only app snapshot on synthetic data: same keys, counts, stages, dates and numbers; every person,
    company, title, link and drafted message replaced by the synthetic world."""
    co_map = {}

    def co(name):
        if not name:
            return name
        if name not in co_map:
            co_map[name] = _COS[len(co_map) % len(_COS)] + ('' if len(co_map) < len(_COS) else ' %d' % (len(co_map) // len(_COS) + 1))
        return co_map[name]

    def person(d, key):
        first, full, url = _synth_person(key)
        out = dict(d)
        if 'name' in d: out['name'] = full
        if 'first' in d: out['first'] = first
        if 'url' in d: out['url'] = url
        if 'company' in d: out['company'] = co(d['company'])
        if 'title' in d: out['title'] = _pick(_TITLES, 't' + key)
        c = out.get('company') or 'your team'
        for k in ('draft', 'dm1', 'note', 'msg'):
            if d.get(k):
                out[k] = ('Thanks for connecting, %s. Most teams like %s we talk to keep customer data out of their AI tools by hand. '
                          'We make that automatic. Worth 15 minutes?' % (first, c)) if k != 'note' else \
                         ('Hi %s, we built a data privacy layer that keeps customer data out of model prompts. Worth connecting?' % first)
        if d.get('why'):
            out['why'] = 'Owns the product area where %s handles sensitive customer data. Hypothesis (synthetic demo).' % c
        return out

    s = json.loads(json.dumps(real))
    for i, u in enumerate(s.get('upnext') or []):
        s['upnext'][i] = person(u, 'u%s%d' % (u.get('id', ''), i))
    for k in ('queued', 'execs', 'handled'):
        s[k] = [person(x, '%s%s%d' % (k, x.get('id', ''), i)) for i, x in enumerate(s.get(k) or [])]
    for k in ('paused',):
        s[k] = [dict(x, company=co(x.get('company'))) for x in (s.get(k) or [])]
    for a in s.get('accounts') or []:
        a['company'] = co(a.get('company'))
        if a.get('id'):
            a['id'] = str(uuid.UUID(hashlib.md5(('acct' + a['id']).encode()).hexdigest()))
        if a.get('status') and a['status'] not in ('new signal', 'Active', 'Mapped', 'Engaged', 'Hold'):
            a['status'] = 'Hold' if a['status'].lower().startswith('hold') else 'Active'
        if a.get('one'):
            a['one'] = 'Synthetic account: a software company that moves customer data into AI features.'
        a['people'] = [dict(p, name=_synth_person('ap' + str(p.get('id', '')) + str(j))[1], title=_pick(_TITLES, 'at%s%d' % (p.get('id', ''), j)))
                       for j, p in enumerate(a.get('people') or [])]
    w = s.get('waiting')
    if isinstance(w, dict) and w.get('names'):
        w['names'] = [_pick(_FIRST, 'w%s%d' % (n, i)) for i, n in enumerate(w['names'])]
    s['asOf'] = s.get('asOf', '')
    return s


def wallet_transform(text):
    """bplus-wallet-mockup: the built page inlines a read-only snapshot of live data as `const REAL = {...};`.
    Replace it with the same snapshot rebuilt on the synthetic world."""
    m = re.search(r'const REAL = (\{.*?\});\n', text, re.S)
    if not m:
        raise RuntimeError('wallet mockup: REAL snapshot not found, cannot scrub it')
    real = json.loads(m.group(1))
    return text[:m.start(1)] + json.dumps(synth_snapshot(real), separators=(',', ':')) + text[m.end(1):]


TRANSFORMS = {'archive/ui/bplus-wallet-mockup.html': wallet_transform}


def refresh_names():
    """Pull real names read-only from the database into names.json (best effort). v18.5: PostgREST reads as the
    restricted worker role (scripts/ari_db.py), no SQL function."""
    try:
        sys.path.insert(0, os.path.join(ROOT, 'scripts'))
        from ari_db import get
        vals = set()
        for r in get('people?select=name,company,owner'):
            vals |= {r.get('name'), r.get('company'), r.get('owner')}
        for r in get('accounts?select=company,owner,ae,meeting_person,domain'):
            vals |= {r.get('company'), r.get('owner'), r.get('ae'), r.get('meeting_person'), r.get('domain')}
        data = [{'v': v} for v in sorted(x for x in vals if x and len(x) > 2)]
        if not data: raise RuntimeError('no names returned')
        json.dump(data, open(os.path.join(KEEL, 'names.json'), 'w'))
        print('names refreshed:', len(data))
    except BaseException as e:
        print('WARN names refresh failed, using cached list:', e)


# Files that must carry Owner's real name (Owner, Oct 23 2026): no name scrub or real-name scan; secret/email scans still run.
NO_SCRUB = {'LICENSE'}

# Dead files inside recursive includes, dropped from the export (Oct 24 2026 scrub build; listed in REPO_MAP).
EXCLUDE = {'app/docs/audit/01-stage1-audit-brief.md', 'app/docs/ci-gate-first-run-failures.md'}

SKIP_DIRS = {'node_modules', 'dist', 'test-results', 'playwright-report', '.vite', '__pycache__', 'coverage'}


def collect():
    files = []
    for spec in INCLUDE:
        src, _, dst = spec.partition(':')
        if src.endswith('/**'):
            top = src[:-3]
            for dp, dns, fns in os.walk(os.path.join(ROOT, top)):
                dns[:] = sorted(d for d in dns if d not in SKIP_DIRS)
                for f in sorted(fns):
                    rel = os.path.relpath(os.path.join(dp, f), ROOT)
                    if rel not in EXCLUDE:
                        files.append((rel, rel))
            continue
        d = os.path.dirname(src)
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for f in sorted(os.listdir(base)):
            if fnmatch.fnmatch(f, os.path.basename(src)) and os.path.isfile(os.path.join(base, f)):
                files.append((os.path.join(d, f), dst or os.path.join(d, f)))
    return files


SQUASH_OK = {'shaleenjha', 'exampleco', 'constructor'}   # public GitHub account; synthetic placeholder; JS keyword


def private_names(rules, ignore):
    """The private real-name list: names.json, every name the scrub map replaces, and the company and website
    columns of accounts.csv and target_accounts_full.csv, minus dictionary words and the ignore list."""
    names = set(x['v'].strip() for x in json.load(open(os.path.join(KEEL, 'names.json'))))
    real = set(names)
    names |= {src for _, _, src, kind in rules if kind in ('l', 'w', 'p') and '@' not in src and len(src) >= 4}
    for fn, cols in (('accounts.csv', ('company',)), ('target_accounts_full.csv', ('company', 'website', 'owner'))):
        try:
            for r in csv.DictReader(open(os.path.join(ROOT, fn), encoding='utf-8')):
                for c in cols:
                    v = (r.get(c) or '').strip()
                    if c == 'website':
                        v = re.sub(r'^(https?://)?(www\.)?', '', v).split('/')[0]
                    if v:
                        names.add(v)
                        real.add(v)
        except OSError:
            pass
    try:
        words = set(open(os.path.join(KEEL, 'dict_words.txt'), encoding='utf-8').read().split())
    except OSError:
        words = set()
    keep = lambda n: len(n) >= 4 and n not in ignore and n.lower() not in words
    return {n for n in names if keep(n)}, {n for n in real if keep(n)}


def name_matcher(names, real):
    """One combined case-sensitive regex for the names (fast on the 1.4 MB ops.html), plus a lowercase squashed form
    of longer names (catches keys like 'acmehealth' in a lookup table)."""
    by_lead = {True: [], False: []}
    for n in sorted(names, key=len, reverse=True):
        by_lead[n[:1].isupper()].append(re.escape(n))
    parts = []
    if by_lead[True]:
        parts.append(r'(?<![A-Z])(?:%s)(?![a-z])' % '|'.join(by_lead[True]))
    if by_lead[False]:
        parts.append(r'(?<![A-Za-z])(?:%s)(?![a-z])' % '|'.join(by_lead[False]))
    rx = re.compile('|'.join(parts)) if parts else None
    squash = {re.sub(r'[^a-z0-9]', '', n.lower()) for n in real}
    squash = {q for q in squash if len(q) >= 8 and q not in SQUASH_OK}
    sq_rx = re.compile(r'(?<![a-z0-9])(?:%s)(?![a-z0-9])' % '|'.join(sorted(squash, key=len, reverse=True))) if squash else None
    return rx, sq_rx


def main():
    if '--refresh-names' in sys.argv:
        refresh_names()
    rules, files, ignore = load_map()
    names, real = private_names(rules, ignore)
    name_rx, squash_rx = name_matcher(names, real)

    # fresh tree, keep .git
    os.makedirs(OUT, exist_ok=True)
    for e in os.listdir(OUT):
        if e == '.git':
            continue
        p = os.path.join(OUT, e)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)

    problems, n = [], 0
    for src, dst in collect():
        sp, dp = os.path.join(ROOT, src), os.path.join(OUT, dst)
        os.makedirs(os.path.dirname(dp), exist_ok=True)
        n += 1
        if src.endswith(BINARY):
            shutil.copy2(sp, dp)
            continue
        t = open(sp, encoding='utf-8').read()
        if dst in TRANSFORMS:
            t = TRANSFORMS[dst](t)
        if dst not in NO_SCRUB and not dst.endswith(GENERATED):
            t = scrub(t, dst, rules, files)
        open(dp, 'w', encoding='utf-8').write(t)
        problems += repo_scan.scan_text(dst, t)
        if dst not in NO_SCRUB and not dst.endswith(GENERATED) and dst not in repo_scan.VENDORED:
            body = repo_scan.strip_data(t)
            if name_rx:
                for m in set(name_rx.findall(body)):
                    problems.append((dst, 'real_name', m))
            if squash_rx:
                for m in set(squash_rx.findall(body.lower())):
                    problems.append((dst, 'real_name_key', m))
    print('exported files:', n, '->', OUT)
    if problems:
        print('SCAN FAILED, %d findings:' % len(problems))
        for p in sorted(set(problems)):
            print('  ', *p)
        sys.exit(2)
    print('scan clean')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Keel: build the scrubbed, code-only export of the app for the private git repo.

Copies an allow-list of code files from the project into the export tree,
applies the private scrub map (real names -> placeholders), then scans the
result for secrets and real names. Exits non-zero if anything is found, so
nothing unsafe is ever committed.

The scrub map and the real-name list live OUTSIDE the repo (in the private
workspace) and must never be committed:
  $KEEL_DIR/scrub_map.json   ordered replacement rules
  $KEEL_DIR/names.json       real names pulled read-only from the database

Usage: python3 scripts/git_export.py [--refresh-names]
"""
import os, re, sys, json, shutil, fnmatch, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
KEEL = os.environ.get('KEEL_DIR', os.path.join(ROOT, 'work', 'keel'))
OUT = os.environ.get('KEEL_EXPORT', os.path.join(KEEL, 'ari-app'))

# Allow-list: only these paths are exported. Everything else stays private.
INCLUDE = [
    'web/ops.html', 'web/sw.js', 'web/vercel.json', 'web/build.json',
    'web/ari.webmanifest', 'web/ari-fonts.css', 'web/ari-supabase.js',
    'web/ari-*.png', 'web/ari-*.woff2', 'web/about.html', 'web/privacy.html', 'web/terms.html', 'web/support.html', 'web/accessibility.html',  # served live (Vercel audit V2), S1 R2
    # native/ari/ moved to archive/native-ari-expo-starter/ (PR #7, Oct 21 2026)
    'native/supabase/migrations/*.sql', 'native/supabase/rollbacks/*.sql',
    'native/supabase/pending/*.sql', 'native/supabase/functions/**',  # S1 R2: '*/index.ts' never matched (audit S4)
    'scripts/brief_upsert.py', 'scripts/daily_report.py', 'scripts/db_backup.py',
    'scripts/deploy_web.py', 'scripts/deploy_app2_preview.py', 'scripts/deploy_provenance.py', 'scripts/offsite_certs.py', 'scripts/test_offsite_certs.py', 'scripts/test_book_prune.py', 'scripts/test_log_repair.py', 'scripts/reply_ingest.py', 'scripts/retro_stats.py',
    'scripts/sync_sheet_supabase.py', 'scripts/git_export.py', 'scripts/git_sync.sh', 'scripts/git_push_api.py', 'scripts/git_pull_remote.py', 'scripts/test_git_sync_pull.py', 'scripts/test_git_push_branch.py',
    'scripts/ari_db.py', 'scripts/backup_check.py', 'scripts/restore_drill.py', 'scripts/offsite_drive.py',
    'scripts/health_check.py', 'scripts/phase0_metrics.py', 'scripts/exec_track_handoff.py', 'scripts/worker_precheck.py', 'scripts/draft_tag.py', 'scripts/copy_switch.py', 'scripts/hygiene_scan.py', 'scripts/test_hygiene_scan.py',
    'native/supabase/tests/*.sql', 'native/supabase/tests/*.ts',
    # Phase 1 (Oct 17 2026): app2 tree + CI, recursive ("dir/**"), build output and deps excluded
    'app2/**', '.github/**',
    # Oct 17 2026: specs, app2 pending migrations, accept ingest
    'docs/specs/*.md', 'docs/engineering/*.md', 'docs/privacy-data-inventory.md', 'docs/runbooks/*.md', 'native/supabase/migrations/pending/**', 'native/supabase/baseline/*.sql',  # schema-only prod baseline for the sql-prod-shape CI job (Oct 18)
     'scripts/accept_ingest.py', 'scripts/gmail_step.py', 'scripts/test_gmail_step.py', 'docs/specs/worker_step0.txt', 'scripts/scan_heartbeat.py', 'scripts/test_scan_heartbeat.py', 'scripts/copy_check.py', 'scripts/relay_check.py', 'scripts/focus_blocks.py', 'scripts/cadence.py',  # Oct 21 2026: called by the worker task every run, were missing from the repo  # v18.15.4 scan dead-man
    'native/supabase/RESTORE.md', 'native/supabase/pending/MAINTENANCE.md', 'native/supabase/offsite/ari-offsite-recipient*.pem',  # S1 R3: every recipient cert (public only)
    'scripts/ari_token.py', 'scripts/test_ari_token.py', 'native/supabase/ops/*.sql',  # S1 R7 (Oct 21 2026): broker token client (ari_db imports it), its tests, kill switch + read-only inventory SQL
    'repo/README.md:README.md', 'repo/gitignore:.gitignore', 'repo/LICENSE:LICENSE',  # Oct 23 2026: all rights reserved
    # Oct 21 2026 (PR docs/repo-map-renames): plain repo map at the root, and archive/ for retired code kept for reference
    'repo/REPO_MAP.md:REPO_MAP.md', 'archive/**',
]
BINARY = ('.png', '.woff2', '.jpg', '.ico')
# package-lock files are machine-generated registry metadata: scanned for secrets, not for real names

# Public-by-design values that are allowed through (noted in README).
ALLOW = [r'sb_publishable_[A-Za-z0-9_]+', r'[a-z]{20}\.supabase\.co', r'BNOi3VJ08tMJ[A-Za-z0-9_-]+']
SECRET = {
    'sb_secret': r'sb_secret_[A-Za-z0-9_]{8,}',
    'jwt': r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}',
    'github_token': r'\bgh[pousr]_[A-Za-z0-9]{20,}',
    'supabase_mgmt': r'\bsbp_[a-f0-9]{30,}',
    'vercel_token': r'\bvercel_[A-Za-z0-9]{20,}',
    'private_key': r'-----BEGIN [A-Z ]*PRIVATE KEY',
    'vapid_private_value': r'"d"\s*:\s*"[A-Za-z0-9_-]{40,}"',
    'crm_id': r'\b00[1-9Q][A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b',
    'apps_script': r'script\.google\.com/macros/s/',
    'sheet_url': r'docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]{20,}',
    'phone_in': r'\+91[ -]?\d{10}\b',
}
EMAIL_OK = re.compile(r'@(example\.com|([a-z0-9-]+\.)*linkedin\.com|users\.noreply\.github\.com)$|^[a-z0-9.-]+@[0-9.]+$', re.I)
# Deliberate lookalike-sender fixtures in the Gmail parser tests (Oct 18 2026); not real addresses.
EMAIL_FIXTURES = {'a@notlinkedin.com', 'invitations@linkedin.com.evil.io'}


def word_re(w):
    # Capitalised words also match inside camelCase identifiers (onFoo, sendFoo).
    lead = r'(?<![A-Z])' if w[:1].isupper() else r'(?<![A-Za-z])'
    return re.compile(lead + re.escape(w) + r'(?![a-z])')


def load_rules():
    rules = json.load(open(os.path.join(KEEL, 'scrub_map.json')))['rules']
    out = []
    for kind, src, dst in rules:
        out.append((re.compile(re.escape(src)) if kind == 'l' else word_re(src), dst, src))
    return out


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


def main():
    if '--refresh-names' in sys.argv:
        refresh_names()
    rules = load_rules()
    names = set(x['v'].strip() for x in json.load(open(os.path.join(KEEL, 'names.json'))))
    names |= {src for _, _, src in rules if '@' not in src and len(src) >= 4}
    ignore = set(json.load(open(os.path.join(KEEL, 'scrub_map.json'))).get('ignore', []))
    names = {n for n in names if len(n) >= 4 and n not in ignore}
    name_res = [word_re(n) for n in sorted(names, key=len, reverse=True)]
    allow = re.compile('|'.join(ALLOW))

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
        if dst not in NO_SCRUB:
            for rx, rep, _ in rules:
                t = rx.sub(rep, t)
        open(dp, 'w', encoding='utf-8').write(t)
        scan = allow.sub('', t)
        for k, p in SECRET.items():
            for m in set(re.findall(p, scan)):
                problems.append((dst, k, m if isinstance(m, str) else m[0]))
        for m in set(re.findall(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', scan)):
            if m not in EMAIL_FIXTURES and not EMAIL_OK.search(m) and not re.search(r'@\d|\.(png|js|css|woff2)$', m):
                problems.append((dst, 'email', m))
        if dst not in NO_SCRUB and not src.endswith(('ari-supabase.js', 'package-lock.json')):  # vendored / generated, scanned for secrets only
            for rx in name_res:
                for m in set(rx.findall(t)):
                    problems.append((dst, 'real_name', m))
    print('exported files:', n, '->', OUT)
    if problems:
        print('SCAN FAILED, %d findings:' % len(problems))
        for p in sorted(set(problems)):
            print('  ', *p)
        sys.exit(2)
    print('scan clean')


if __name__ == '__main__':
    main()

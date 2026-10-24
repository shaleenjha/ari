#!/usr/bin/env python3
"""Deploy provenance gate (S1 R2, Oct 19 2026; Basalt H3, Vercel audit V2).

A deploy may only ship code that is exactly a commit on GitHub `main` whose CI run concluded success.
This workspace is not a git checkout: git_sync.sh exports a scrubbed, allow-listed copy to work/keel/ari-app and
git_push_api.py mirrors that tree onto `main`. So the gate compares git TREES (content hashes), not commit ids:

  1. Working tree clean: a fresh export of the current workspace (git_export.py into a temp dir, same allow-list,
     same scrub, same secret scan) has the same tree hash as the tip of GitHub `main`. Any uncommitted change to an
     exported file, any added or removed file, changes the tree hash.
  2. HEAD equals origin/main: the local export repo's HEAD tree equals the tip of GitHub `main` (nothing committed
     locally and left unpushed, nobody else pushed since).
  3. CI green: every GitHub Actions run for that `main` SHA (ignoring issue/comment-triggered agent runs) is completed, at least one is the `ci` workflow, and all
     concluded `success`.

Limits (stated, not hidden): files outside the export allow-list are invisible to check 1, so callers must refuse to
upload them (exported_paths() gives the list). Real-name scrubbing means a change that only touches a scrubbed name is
not seen; the scrub map covers prospect data, not code.

Needs GitHub API access: run the deploy in a shell call with credentials [{"provider":"github"}] (as git_sync.sh does).
Usage as a check only: python3 scripts/deploy_provenance.py   (prints the SHA, exit 0; or REFUSED, exit 3)
"""
import os, sys, json, shutil, subprocess, tempfile, urllib.request, urllib.error

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
KEEL = os.environ.get('KEEL_DIR', os.path.join(ROOT, 'work', 'keel'))
LOCAL = os.environ.get('KEEL_EXPORT', os.path.join(KEEL, 'ari-app'))
REPO = os.environ.get('KEEL_REPO', 'shaleenjha/ari')
API = 'https://api.github.com'


class Refused(SystemExit):
    def __init__(self, msg):
        self.msg = 'REFUSED (provenance gate): ' + msg + ' Nothing deployed.'
        sys.stderr.write(self.msg + '\n')
        super().__init__(3)


def _gh(path):
    req = urllib.request.Request(API + path, headers={'Accept': 'application/vnd.github+json',
                                                      'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise Refused('GitHub %s -> %s (run with GitHub credentials)' % (path, e.code))
    except urllib.error.URLError as e:
        raise Refused('GitHub unreachable: %s' % e.reason)


def _git(*a, cwd):
    return subprocess.run(['git', *a], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def _export_tree():
    """Export the workspace exactly as git_sync.sh would (cached name list, no database read) and hash it."""
    tmp = tempfile.mkdtemp(prefix='ari-prov-')
    try:
        env = dict(os.environ, KEEL_DIR=KEEL, KEEL_EXPORT=tmp)
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'git_export.py')], env=env,
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise Refused('export scan failed, so the workspace cannot match any commit:\n' + r.stdout[-1500:])
        _git('init', '-q', cwd=tmp)
        _git('add', '-A', cwd=tmp)
        tree = _git('write-tree', cwd=tmp)
        paths = set(_git('ls-files', cwd=tmp).splitlines())
        return tree, paths
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def exported_paths():
    return _export_tree()[1]


def check():
    """Return {'sha', 'tree', 'ci_runs', 'paths'} for the GitHub main commit the workspace equals, or raise Refused."""
    ref = _gh('/repos/%s/git/ref/heads/main' % REPO)
    sha = ref['object']['sha']
    remote_tree = _gh('/repos/%s/git/commits/%s' % (REPO, sha))['tree']['sha']

    tree, paths = _export_tree()
    if tree != remote_tree:
        raise Refused('working tree is not clean: the workspace export (tree %s) differs from GitHub main %s (tree %s). '
                      'Commit with scripts/git_sync.sh, wait for CI, then deploy.' % (tree[:10], sha[:10], remote_tree[:10]))
    if os.path.isdir(os.path.join(LOCAL, '.git')):
        head_tree = _git('rev-parse', 'HEAD^{tree}', cwd=LOCAL)
        if head_tree != remote_tree:
            raise Refused('local export HEAD (tree %s) is not GitHub main %s (tree %s).' % (head_tree[:10], sha[:10], remote_tree[:10]))

    runs = _gh('/repos/%s/actions/runs?head_sha=%s&per_page=50' % (REPO, sha)).get('workflow_runs', [])
    # Runs fired by issue/comment events (the @claude agent) are not checks of this commit: GitHub stamps them with
    # main's SHA, they are often skipped or long-running, and they vouch for nothing. Only check-type events count.
    runs = [r for r in runs if r.get('event') not in ('issues', 'issue_comment', 'pull_request_review_comment', 'pull_request_review')]
    if not runs:
        raise Refused('no CI run found for main %s yet.' % sha[:10])
    if not any(r.get('name') == 'ci' for r in runs):
        raise Refused('the ci workflow has not run for main %s.' % sha[:10])
    bad = [(r['id'], r['name'], r['status'], r['conclusion']) for r in runs
           if r.get('status') != 'completed' or r.get('conclusion') != 'success']
    if bad:
        raise Refused('CI for main %s is not green: %s' % (sha[:10], bad))
    return {'sha': sha, 'tree': remote_tree, 'ci_runs': [r['id'] for r in runs], 'paths': paths}


def vercel_meta(p, deployer):
    """Deployment meta (Vercel keeps string values only)."""
    return {'githubCommitSha': p['sha'], 'githubCommitRef': 'main', 'githubRepo': REPO.split('/')[1],
            'ariTree': p['tree'], 'ariCiRun': str(p['ci_runs'][0]), 'ariDeployer': deployer}


if __name__ == '__main__':
    p = check()
    print(json.dumps({'ok': True, 'sha': p['sha'], 'tree': p['tree'], 'ci_runs': p['ci_runs']}))

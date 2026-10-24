#!/usr/bin/env python3
"""Keel: push the local export repo's HEAD to the private GitHub repo via the git data API.

The sandbox has no git credentials; the Hark identity gateway authenticates
requests to api.github.com when the shell call carries credentials
[{"provider":"github"}]. This mirrors the local HEAD tree onto remote `main`
as one commit carrying the local commit message (only changed blobs upload).

Pull-first (v18.17.10): scripts/git_pull_remote.py runs first and records the remote HEAD it synced to in the
state file. This script refuses to push unless remote main is still exactly that commit, pushes as its child
(never force), then records the new commit as last_pushed for the next pull.

Usage: python3 scripts/git_push_api.py <export_dir> [owner/repo]
       python3 scripts/git_push_api.py <export_dir> [owner/repo] --branch <name>   (review branch, see push_branch)
Repo defaults to $KEEL_REPO or shaleenjha/ari (public by Owner's choice, Oct 24 2026). A public repo is allowed only if listed in PUBLIC_OK; any other public repo is refused.
"""
PUBLIC_OK = {'shaleenjha/ari'}  # Owner, Oct 24 2026: the scrubbed repo is public
import os, re, sys, json, base64, subprocess, urllib.request, urllib.error

API = 'https://api.github.com'


def gh(method, path, body=None, ok404=False):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
                                          'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode()
            return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        msg = e.read().decode()[:500]
        if ok404 and e.code in (404, 409):
            return None
        raise SystemExit('GitHub %s %s -> %s %s' % (method, path, e.code, msg))


def git(*a, cwd):
    return subprocess.run(['git', *a], cwd=cwd, capture_output=True, check=True).stdout


def main():
    args = sys.argv[1:]
    branch = None
    if '--branch' in args:
        i = args.index('--branch')
        if i + 1 >= len(args) or args[i + 1].startswith('-'):
            raise SystemExit('usage: git_push_api.py <export_dir> [owner/repo] --branch <name>  (--branch needs a name)')
        branch = args[i + 1]; del args[i:i + 2]
    if not args:
        raise SystemExit('usage: git_push_api.py <export_dir> [owner/repo] [--branch <name>]')
    src = os.path.abspath(args[0])
    repo = args[1] if len(args) > 1 else os.environ.get('KEEL_REPO', 'shaleenjha/ari')
    push_branch(gh, repo, src, branch) if branch else push(gh, repo, src)


_REF_BAD = re.compile(r'[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|//')


def check_branch(branch):
    """Refuse main/master and any name git would reject as refs/heads/<name> (git check-ref-format rules): no spaces or
    control chars, none of ~ ^ : ? * [ \\, no '..', '@{' or '//', no leading '-' or '/', no trailing '/' or '.', no
    component starting with '.' or ending in '.lock', not '@'."""
    if (not isinstance(branch, str) or not branch or branch in ('main', 'master', '@') or branch.startswith(('-', '/'))
            or branch.endswith(('/', '.')) or _REF_BAD.search(branch)
            or any(c.startswith('.') or c.endswith('.lock') or not c for c in branch.split('/'))):
        raise SystemExit('REFUSING: bad branch name %r (never main)' % (branch,))
    if subprocess.run(['git', 'check-ref-format', 'refs/heads/' + branch], capture_output=True).returncode != 0:
        raise SystemExit('REFUSING: bad branch name %r (git check-ref-format)' % (branch,))


def changed_paths(src, base):
    """(status, path) pairs from base to HEAD. -z keeps paths with spaces, quotes or non-ASCII bytes exact (no C-quoting)."""
    out = git('diff', '-z', '--no-renames', '--name-status', base, 'HEAD', cwd=src).decode('utf-8', 'surrogateescape')
    parts = out.split('\0')
    if parts and parts[-1] == '':
        parts.pop()
    if len(parts) % 2:
        raise SystemExit('REFUSING: could not parse git diff -z output')
    return [(parts[i], parts[i + 1]) for i in range(0, len(parts), 2)]


def push_branch(gh, repo, src, branch):
    """Push local commits to a review branch (for a PR), never to main and never forced.

    Parent = the remote branch head if it exists, else remote main. The local history must contain a commit whose tree
    is exactly the parent's tree (the work was cut from it); only the paths added or modified since that commit go up,
    layered on the parent tree (base_tree), so files changed elsewhere are never reverted and nothing remote is deleted
    (a local deletion refuses). The author is the local commit's and must be a GitHub noreply address. The sync state
    file is not touched, so the main pull/push cycle is unaffected. A change under .github/ refuses: workflow edits
    on a review branch run in CI with the repo's secrets before anyone reviews them, so they go through main.
    """
    check_branch(branch)
    info = gh('GET', '/repos/' + repo)
    if not info.get('private') and repo not in PUBLIC_OK:
        raise SystemExit('REFUSING: %s is public and not in PUBLIC_OK' % repo)
    msg = git('log', '-1', '--format=%B', cwd=src).decode().strip()
    name, email = git('log', '-1', '--format=%an%x00%ae', cwd=src).decode().strip().split('\x00')
    if not email.endswith('@users.noreply.github.com'):
        raise SystemExit('REFUSING: commit author must be a GitHub noreply address, got %s' % email)
    bref = gh('GET', '/repos/%s/git/ref/heads/%s' % (repo, branch), ok404=True)
    parent = (bref or gh('GET', '/repos/%s/git/ref/heads/main' % repo))['object']['sha']
    ptree = gh('GET', '/repos/%s/git/commits/%s' % (repo, parent))['tree']['sha']
    base = next((c for c in git('rev-list', 'HEAD', cwd=src).decode().split()
                 if git('rev-parse', c + '^{tree}', cwd=src).decode().strip() == ptree), None)
    if base is None:
        raise SystemExit('REFUSING: no local commit has the tree of remote %s (%s); cut the work from it first'
                         % (branch if bref else 'main', parent[:10]))
    changes = changed_paths(src, base)
    gone = [p for s, p in changes if s != 'A' and s != 'M']
    if gone:
        raise SystemExit('REFUSING: branch push never deletes remote files: %s' % ', '.join(gone))
    ci = [p for _, p in changes if p == '.github' or p.startswith('.github/')]
    if ci:
        raise SystemExit('REFUSING: branch push never changes .github/ (CI runs it unreviewed): %s' % ', '.join(ci))
    if not changes:
        print('branch %s already up to date at %s' % (branch, parent[:10]))
        return parent
    tree = []
    for _, path in changes:
        mode, _, sha = git('ls-tree', 'HEAD', '--', path, cwd=src).decode().split('\t', 1)[0].split()
        data = git('cat-file', 'blob', sha, cwd=src)
        b = gh('POST', '/repos/%s/git/blobs' % repo, {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
        assert b['sha'] == sha, 'blob sha mismatch for ' + path
        tree.append({'path': path, 'mode': mode, 'type': 'blob', 'sha': sha})
    new_tree = gh('POST', '/repos/%s/git/trees' % repo, {'base_tree': ptree, 'tree': tree})['sha']
    c = gh('POST', '/repos/%s/git/commits' % repo, {'message': msg, 'tree': new_tree, 'parents': [parent],
                                                   'author': {'name': name, 'email': email}})
    if bref:
        gh('PATCH', '/repos/%s/git/refs/heads/%s' % (repo, branch), {'sha': c['sha'], 'force': False})
    else:
        gh('POST', '/repos/%s/git/refs' % repo, {'ref': 'refs/heads/' + branch, 'sha': c['sha']})
    print('pushed %s -> %s %s (%d files): %s' % (c['sha'][:10], repo, branch, len(tree), msg))
    return c['sha']


def push(gh, repo, src, state_path=None):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from git_pull_remote import load_state, save_state
    st = load_state(state_path)
    info = gh('GET', '/repos/' + repo)
    if not info.get('private') and repo not in PUBLIC_OK:
        raise SystemExit('REFUSING: %s is public and not in PUBLIC_OK' % repo)
    msg = git('log', '-1', '--format=%B', cwd=src).decode().strip()
    local = {}
    for line in git('ls-tree', '-r', 'HEAD', cwd=src).decode().splitlines():
        meta, path = line.split('\t', 1)
        mode, _, sha = meta.split()
        local[path] = (mode, sha)

    ref = gh('GET', '/repos/%s/git/ref/heads/main' % repo, ok404=True)
    if ref is None:  # empty repo: nothing to pull, so the pull-first check below does not apply
        # the git data API needs one commit first
        gh('PUT', '/repos/%s/contents/.keel-init' % repo,
           {'message': 'init', 'content': base64.b64encode(b'init\n').decode(), 'branch': 'main'})
        ref = gh('GET', '/repos/%s/git/ref/heads/main' % repo)
        st['pulled_head'] = ref['object']['sha']
    parent = ref['object']['sha']
    if st.get('pulled_head') != parent:
        raise SystemExit('REFUSING: remote main is %s but the last pull synced to %s; run git_sync.sh again '
                         '(pull first, never force)' % (parent[:10], str(st.get('pulled_head'))[:10]))
    ptree = gh('GET', '/repos/%s/git/commits/%s' % (repo, parent))['tree']['sha']
    remote = {e['path']: e['sha'] for e in gh('GET', '/repos/%s/git/trees/%s?recursive=1' % (repo, ptree))['tree']
              if e['type'] == 'blob'}

    tree, uploaded = [], 0
    for path, (mode, sha) in sorted(local.items()):
        if remote.get(path) != sha:
            data = git('cat-file', 'blob', sha, cwd=src)
            b = gh('POST', '/repos/%s/git/blobs' % repo, {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
            assert b['sha'] == sha, 'blob sha mismatch for ' + path
            uploaded += 1
        tree.append({'path': path, 'mode': mode, 'type': 'blob', 'sha': sha})
    new_tree = gh('POST', '/repos/%s/git/trees' % repo, {'tree': tree})['sha']  # full tree: deletions propagate
    if new_tree == ptree:
        print('remote already up to date', parent[:10])
        st.update(last_pushed=parent, pulled_head=None); save_state(st, state_path)
        return parent
    c = gh('POST', '/repos/%s/git/commits' % repo, {'message': msg, 'tree': new_tree, 'parents': [parent],
                                                   'author': {'name': 'Owner', 'email': '36487118+shaleenjha@users.noreply.github.com'}})
    gh('PATCH', '/repos/%s/git/refs/heads/main' % repo, {'sha': c['sha'], 'force': False})
    st.update(last_pushed=c['sha'], pulled_head=None); save_state(st, state_path)
    print('pushed %s -> %s main (%d files, %d blobs uploaded): %s' % (c['sha'][:10], repo, len(tree), uploaded, msg))
    return c['sha']


if __name__ == '__main__':
    main()

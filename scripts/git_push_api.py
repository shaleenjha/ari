#!/usr/bin/env python3
"""Keel: push the local export repo's HEAD to the private GitHub repo via the git data API.

The sandbox has no git credentials; the Hark identity gateway authenticates
requests to api.github.com when the shell call carries credentials
[{"provider":"github"}]. This mirrors the local HEAD tree onto remote `main`
as one commit carrying the local commit message (only changed blobs upload).

Usage: python3 scripts/git_push_api.py <export_dir> [owner/repo]
Repo defaults to $KEEL_REPO or shaleenjha/crm.os. Refuses to push to a public repo.
"""
import os, sys, json, base64, subprocess, urllib.request, urllib.error

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
    src = os.path.abspath(sys.argv[1])
    repo = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('KEEL_REPO', 'shaleenjha/crm.os')
    info = gh('GET', '/repos/' + repo)
    if not info.get('private'):
        raise SystemExit('REFUSING: %s is not private' % repo)
    msg = git('log', '-1', '--format=%B', cwd=src).decode().strip()
    local = {}
    for line in git('ls-tree', '-r', 'HEAD', cwd=src).decode().splitlines():
        meta, path = line.split('\t', 1)
        mode, _, sha = meta.split()
        local[path] = (mode, sha)

    ref = gh('GET', '/repos/%s/git/ref/heads/main' % repo, ok404=True)
    if ref is None:  # empty repo: the git data API needs one commit first
        gh('PUT', '/repos/%s/contents/.keel-init' % repo,
           {'message': 'init', 'content': base64.b64encode(b'init\n').decode(), 'branch': 'main'})
        ref = gh('GET', '/repos/%s/git/ref/heads/main' % repo)
    parent = ref['object']['sha']
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
        return
    c = gh('POST', '/repos/%s/git/commits' % repo, {'message': msg, 'tree': new_tree, 'parents': [parent],
                                                   'author': {'name': 'Keel', 'email': 'keel@users.noreply.github.com'}})
    gh('PATCH', '/repos/%s/git/refs/heads/main' % repo, {'sha': c['sha'], 'force': False})
    print('pushed %s -> %s main (%d files, %d blobs uploaded): %s' % (c['sha'][:10], repo, len(tree), uploaded, msg))


if __name__ == '__main__':
    main()

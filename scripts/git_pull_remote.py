#!/usr/bin/env python3
"""Keel: pull-first step of git_sync.sh. Brings commits made on GitHub (web edits, merged @claude PRs) into the
project before we push, so our full-tree push never deletes them.

Flow (stdlib only, GitHub git data API through the identity gateway):
  1. Read our last pushed SHA from the state file ($KEEL_DIR/.git_sync_state.json, under work/, never committed).
     No state yet: bootstrap from the remote commit whose tree equals the export repo's HEAD tree.
  2. Remote HEAD == last pushed: nothing to pull.
  3. Else diff tree(last) vs tree(HEAD) = remote changes R; diff the fresh export tree vs tree(last) = local
     changes L. R and L share a path: print "conflict: <paths>, resolve first", exit 1, push nothing.
  4. Apply R to the project source (export path -> source path via git_export.INCLUDE): added files written,
     deletions removed, modified files merged with `git merge-file` (base = last pushed, ours = source,
     theirs = remote) so scrubbed placeholders never overwrite real values in the source. A remote path outside
     the export allow-list also stops the sync (it would be deleted on push).
  5. Record {"pulled_head": HEAD} so git_push_api.py pushes as a child of exactly that commit.

Usage: python3 scripts/git_pull_remote.py <export_dir> [owner/repo]
Exit: 0 ok, 1 conflict / refused, 2 bad state.
"""
import os, sys, json, base64, fnmatch, subprocess, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
KEEL = os.environ.get('KEEL_DIR', os.path.join(ROOT, 'work', 'keel'))
STATE = os.environ.get('KEEL_STATE', os.path.join(KEEL, '.git_sync_state.json'))


class Refuse(Exception):
    pass


def load_state(path=None):
    path = path or STATE
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def save_state(st, path=None):
    path = path or STATE
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(st, f, indent=1)


def dst_to_src(path, include):
    """Map an exported repo path back to its project source path, or None if not on the allow-list."""
    for spec in include:
        src, _, dst = spec.partition(':')
        if dst:
            if path == dst:
                return src
            continue
        if src.endswith('/**'):
            if path.startswith(src[:-2]):
                return path
        elif os.path.dirname(path) == os.path.dirname(src) and fnmatch.fnmatch(os.path.basename(path), os.path.basename(src)):
            return path
    return None


def blob_sha(data):
    return subprocess.run(['git', 'hash-object', '--stdin'], input=data, capture_output=True, check=True).stdout.decode().strip()


def export_files(export_dir):
    out = {}
    for dp, dns, fns in os.walk(export_dir):
        dns[:] = [d for d in dns if d != '.git']
        for f in fns:
            p = os.path.join(dp, f)
            out[os.path.relpath(p, export_dir)] = blob_sha(open(p, 'rb').read())
    return out


class Remote:
    def __init__(self, gh, repo):
        self.gh, self.repo = gh, repo

    def head(self):
        return self.gh('GET', '/repos/%s/git/ref/heads/main' % self.repo)['object']['sha']

    def tree_of(self, commit):
        t = self.gh('GET', '/repos/%s/git/commits/%s' % (self.repo, commit))['tree']['sha']
        return {e['path']: e['sha'] for e in self.gh('GET', '/repos/%s/git/trees/%s?recursive=1' % (self.repo, t))['tree']
                if e['type'] == 'blob'}

    def blob(self, sha):
        return base64.b64decode(self.gh('GET', '/repos/%s/git/blobs/%s' % (self.repo, sha))['content'])

    def find_by_tree(self, tree_sha):
        for c in self.gh('GET', '/repos/%s/commits?sha=main&per_page=50' % self.repo):
            if c['commit']['tree']['sha'] == tree_sha:
                return c['sha']
        return None


def merge3(base, ours, theirs):
    if ours == base:
        return theirs
    if theirs == base or ours == theirs:
        return ours
    with tempfile.TemporaryDirectory() as d:
        ps = []
        for n, b in (('ours', ours), ('base', base), ('theirs', theirs)):
            ps.append(os.path.join(d, n)); open(ps[-1], 'wb').write(b)
        r = subprocess.run(['git', 'merge-file', '-p', *ps], capture_output=True)
        if r.returncode != 0:
            return None
        return r.stdout


def pull(gh, repo, export_dir, root, include, state_path=None, local_tree_sha=None, log=print):
    """Returns the list of pulled changes [(op, path)]. Raises Refuse on conflict."""
    rem = Remote(gh, repo)
    st = load_state(state_path)
    last = st.get('last_pushed')
    if not last:
        if not local_tree_sha:
            raise Refuse('no sync state and no local HEAD to bootstrap from; set last_pushed in %s' % (state_path or STATE))
        last = rem.find_by_tree(local_tree_sha)
        if not last:
            raise Refuse('no sync state and no remote commit matches the local HEAD tree; set last_pushed by hand')
        log('sync state bootstrapped: last pushed = %s' % last[:10])
        st['last_pushed'] = last
    head = rem.head()
    st['pulled_head'] = head
    if head == last:
        save_state(st, state_path)
        log('pull: remote has no new commits (%s)' % head[:10])
        return []
    base, new = rem.tree_of(last), rem.tree_of(head)
    rchg = {p for p in set(base) | set(new) if base.get(p) != new.get(p)}
    loc = export_files(export_dir)
    lchg = {p for p in set(base) | set(loc) if base.get(p) != loc.get(p)}
    both = sorted(rchg & lchg)
    if both:
        raise Refuse('conflict: %s, resolve first' % ', '.join(both))
    outside = sorted(p for p in rchg if p in new and dst_to_src(p, include) is None)
    if outside:
        raise Refuse('remote added paths outside the export allow-list (add them to git_export.INCLUDE first): %s'
                     % ', '.join(outside))
    done, staged = [], []
    for p in sorted(rchg):
        src = dst_to_src(p, include) or p
        sp = os.path.join(root, src)
        if p not in new:
            staged.append(('deleted', p, sp, None))
        elif p not in base:
            staged.append(('added', p, sp, rem.blob(new[p])))
        else:
            ours = open(sp, 'rb').read() if os.path.exists(sp) else rem.blob(base[p])
            merged = merge3(rem.blob(base[p]), ours, rem.blob(new[p]))
            if merged is None:
                raise Refuse('conflict: %s (remote edit overlaps a scrubbed line), resolve first' % p)
            staged.append(('modified', p, sp, merged))
    for op, p, sp, data in staged:  # apply only after every path merged cleanly
        if data is None:
            if os.path.exists(sp):
                os.remove(sp)
        else:
            os.makedirs(os.path.dirname(sp), exist_ok=True)
            open(sp, 'wb').write(data)
        done.append((op, p))
        log('pulled %s %s' % (op, p))
    save_state(st, state_path)
    log('pull: %d file(s) from remote %s..%s' % (len(done), last[:10], head[:10]))
    return done


def main():
    sys.path.insert(0, os.path.join(ROOT, 'scripts'))
    from git_push_api import gh
    from git_export import INCLUDE
    export_dir = os.path.abspath(sys.argv[1])
    repo = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('KEEL_REPO', 'shaleenjha/crm.os')
    tree = None
    if os.path.isdir(os.path.join(export_dir, '.git')):
        r = subprocess.run(['git', 'rev-parse', 'HEAD^{tree}'], cwd=export_dir, capture_output=True)
        tree = r.stdout.decode().strip() if r.returncode == 0 else None
    try:
        done = pull(gh, repo, export_dir, ROOT, INCLUDE, local_tree_sha=tree)
    except Refuse as e:
        print('PULL REFUSED:', e)
        sys.exit(1)
    if done:
        print('PULLED_FILES=%d' % len(done))


if __name__ == '__main__':
    main()

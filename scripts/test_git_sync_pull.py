#!/usr/bin/env python3
"""Tests for the pull-first git sync (scripts/git_pull_remote.py + git_push_api.push) against a mocked GitHub API.
Synthetic files only. Run: python3 scripts/test_git_sync_pull.py"""
import os, sys, json, base64, hashlib, shutil, subprocess, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import git_pull_remote as gp
import git_push_api as gpa

INCLUDE = ['web/*.html', 'scripts/*.py', 'docs/**', 'repo/README.md:README.md']


def hobj(data):
    return gp.blob_sha(data)


class FakeGitHub:
    """Just enough of the git data API: refs, commits, recursive trees, blobs, commit list."""
    def __init__(self):
        self.blobs, self.trees, self.commits, self.ref = {}, {}, {}, None

    def commit(self, files, parent=None, tree_sha=None):
        entries = {}
        for p, data in files.items():
            s = hobj(data); self.blobs[s] = data; entries[p] = s
        t = tree_sha or hashlib.sha1(json.dumps(sorted(entries.items())).encode()).hexdigest()
        self.trees[t] = entries
        c = hashlib.sha1(('%s%s%d' % (t, parent, len(self.commits))).encode()).hexdigest()
        self.commits[c] = {'tree': t, 'parent': parent}
        self.ref = c
        return c

    def __call__(self, method, path, body=None, ok404=False):
        p = path.split('/repos/o/r', 1)[1]
        if method == 'GET' and p == '':
            return {'private': True}
        if method == 'GET' and p == '/git/ref/heads/main':
            return {'object': {'sha': self.ref}}
        if method == 'GET' and p.startswith('/git/commits/'):
            return {'tree': {'sha': self.commits[p.rsplit('/', 1)[1]]['tree']}}
        if method == 'GET' and p.startswith('/git/trees/'):
            t = p.split('/git/trees/')[1].split('?')[0]
            return {'tree': [{'path': k, 'sha': v, 'type': 'blob'} for k, v in self.trees[t].items()]}
        if method == 'GET' and p.startswith('/git/blobs/'):
            return {'content': base64.b64encode(self.blobs[p.rsplit('/', 1)[1]]).decode()}
        if method == 'GET' and p.startswith('/commits?'):
            out, c = [], self.ref
            while c:
                out.append({'sha': c, 'commit': {'tree': {'sha': self.commits[c]['tree']}}}); c = self.commits[c]['parent']
            return out
        if method == 'POST' and p == '/git/blobs':
            data = base64.b64decode(body['content']); s = hobj(data); self.blobs[s] = data
            return {'sha': s}
        if method == 'POST' and p == '/git/trees':
            entries = {e['path']: e['sha'] for e in body['tree']}
            t = hashlib.sha1(json.dumps(sorted(entries.items())).encode()).hexdigest(); self.trees[t] = entries
            return {'sha': t}
        if method == 'POST' and p == '/git/commits':
            assert body['author']['email'].endswith('@users.noreply.github.com')
            c = hashlib.sha1(('%s%s%d' % (body['tree'], body['parents'], len(self.commits))).encode()).hexdigest()
            self.commits[c] = {'tree': body['tree'], 'parent': body['parents'][0]}
            return {'sha': c}
        if method == 'PATCH' and p == '/git/refs/heads/main':
            assert body['force'] is False
            assert self.commits[body['sha']]['parent'] == self.ref, 'non fast-forward'
            self.ref = body['sha']
            return {}
        raise AssertionError('unmocked %s %s' % (method, path))


BASE = {'web/a.html': b'<p>a</p>\n', 'web/b.html': b'<p>b</p>\n', 'scripts/x.py': b'print(1)\n', 'README.md': b'readme\n'}


class PullFirst(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.root, self.exp = os.path.join(self.d, 'root'), os.path.join(self.d, 'export')
        self.state = os.path.join(self.d, 'state.json')
        for p, data in BASE.items():
            self.write(self.exp, p, data)
            self.write(self.root, 'repo/README.md' if p == 'README.md' else p, data)
        self.gh = FakeGitHub()
        self.c1 = self.gh.commit(BASE)
        gp.save_state({'last_pushed': self.c1}, self.state)

    def tearDown(self):
        shutil.rmtree(self.d)

    def write(self, base, p, data):
        os.makedirs(os.path.dirname(os.path.join(base, p)), exist_ok=True)
        open(os.path.join(base, p), 'wb').write(data)

    def pull(self):
        return gp.pull(self.gh, 'o/r', self.exp, self.root, INCLUDE, state_path=self.state, log=lambda *a: None)

    def test_remote_only_file_is_pulled(self):
        self.gh.commit(dict(BASE, **{'docs/new.md': b'from github\n', 'README.md': b'readme v2\n'}), parent=self.c1)
        done = self.pull()
        self.assertEqual(sorted(done), [('added', 'docs/new.md'), ('modified', 'README.md')])
        self.assertEqual(open(os.path.join(self.root, 'docs/new.md'), 'rb').read(), b'from github\n')
        self.assertEqual(open(os.path.join(self.root, 'repo/README.md'), 'rb').read(), b'readme v2\n')

    def test_remote_deletion_applied(self):
        files = dict(BASE); del files['web/b.html']
        self.gh.commit(files, parent=self.c1)
        self.assertEqual(self.pull(), [('deleted', 'web/b.html')])
        self.assertFalse(os.path.exists(os.path.join(self.root, 'web/b.html')))

    def test_same_path_conflict_refuses_and_writes_nothing(self):
        self.gh.commit(dict(BASE, **{'web/a.html': b'<p>remote</p>\n', 'docs/new.md': b'n\n'}), parent=self.c1)
        self.write(self.exp, 'web/a.html', b'<p>local</p>\n')
        with self.assertRaises(gp.Refuse) as e:
            self.pull()
        self.assertIn('conflict: web/a.html, resolve first', str(e.exception))
        self.assertFalse(os.path.exists(os.path.join(self.root, 'docs/new.md')))

    def test_scrubbed_source_keeps_real_values(self):
        mid = b'a = 0\nb = 0\nc = 0\n'  # git merge-file treats adjacent edits as a conflict, so keep them apart
        base = b'owner = "Owner"\n' + mid + b'x = 1\n'
        self.c1 = self.gh.commit(dict(BASE, **{'scripts/s.py': base}), parent=self.c1)
        gp.save_state({'last_pushed': self.c1}, self.state)
        self.write(self.exp, 'scripts/s.py', base)
        self.write(self.root, 'scripts/s.py', b'owner = "Real Person"\n' + mid + b'x = 1\n')  # source before scrub
        self.gh.commit(dict(BASE, **{'scripts/s.py': b'owner = "Owner"\n' + mid + b'x = 2\n'}), parent=self.c1)
        self.assertEqual(self.pull(), [('modified', 'scripts/s.py')])
        self.assertEqual(open(os.path.join(self.root, 'scripts/s.py'), 'rb').read(),
                         b'owner = "Real Person"\n' + mid + b'x = 2\n')

    def test_remote_path_outside_allow_list_refuses(self):
        self.gh.commit(dict(BASE, **{'secret/notes.txt': b'x\n'}), parent=self.c1)
        with self.assertRaises(gp.Refuse) as e:
            self.pull()
        self.assertIn('outside the export allow-list', str(e.exception))

    def test_bootstrap_from_local_tree(self):
        os.remove(self.state)
        self.gh.commit(BASE, parent=self.c1, tree_sha='LOCALTREE')
        head = self.gh.ref
        self.assertEqual(gp.pull(self.gh, 'o/r', self.exp, self.root, INCLUDE, state_path=self.state,
                                 local_tree_sha='LOCALTREE', log=lambda *a: None), [])
        self.assertEqual(gp.load_state(self.state)['last_pushed'], head)

    def git_export_repo(self):
        g = lambda *a: subprocess.run(['git', *a], cwd=self.exp, check=True, capture_output=True)
        g('init', '-q', '-b', 'main'); g('add', '-A')
        g('-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'v0.1: test')

    def test_no_remote_changes_normal_push(self):
        self.write(self.exp, 'web/a.html', b'<p>new local</p>\n')
        self.assertEqual(self.pull(), [])
        self.git_export_repo()
        new = gpa.push(self.gh, 'o/r', self.exp, state_path=self.state)
        self.assertEqual(self.gh.ref, new)
        self.assertEqual(self.gh.commits[new]['parent'], self.c1)
        self.assertEqual(gp.load_state(self.state)['last_pushed'], new)

    def test_push_after_pull_is_child_of_remote_head_and_keeps_remote_file(self):
        c2 = self.gh.commit(dict(BASE, **{'docs/new.md': b'from github\n'}), parent=self.c1)
        self.pull()
        self.write(self.exp, 'docs/new.md', b'from github\n')  # what the re-export does
        self.write(self.exp, 'scripts/x.py', b'print(2)\n')  # plus our own local change
        self.git_export_repo()
        new = gpa.push(self.gh, 'o/r', self.exp, state_path=self.state)
        self.assertEqual(self.gh.commits[new]['parent'], c2)
        self.assertIn('docs/new.md', self.gh.trees[self.gh.commits[new]['tree']])

    def test_push_refuses_if_remote_moved_after_pull(self):
        self.pull()
        self.gh.commit(dict(BASE, **{'docs/late.md': b'l\n'}), parent=self.c1)
        self.git_export_repo()
        with self.assertRaises(SystemExit) as e:
            gpa.push(self.gh, 'o/r', self.exp, state_path=self.state)
        self.assertIn('REFUSING', str(e.exception))


if __name__ == '__main__':
    unittest.main(verbosity=2)

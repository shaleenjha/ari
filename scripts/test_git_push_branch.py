#!/usr/bin/env python3
"""Tests for git_push_api.push_branch (review-branch push for PRs) against a mocked GitHub API.
Synthetic files only. Run: python3 scripts/test_git_push_branch.py"""
import os, sys, shutil, subprocess, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import git_push_api as gpa
from test_git_sync_pull import FakeGitHub

NOREPLY = '1+test@users.noreply.github.com'
BASE = {'app/a.ts': b'a\n', 'app/b.ts': b'b\n', 'README.md': b'readme\n'}


class FakeBranches(FakeGitHub):
    """FakeGitHub plus branch refs, ref creation and base_tree trees."""
    def __init__(self):
        super().__init__()
        self.branches, self.authors = {}, []

    def __call__(self, method, path, body=None, ok404=False):
        p = path.split('/repos/o/r', 1)[1]
        if method == 'GET' and p.startswith('/git/ref/heads/') and p != '/git/ref/heads/main':
            b = self.branches.get(p[len('/git/ref/heads/'):])
            return {'object': {'sha': b}} if b else None
        if method == 'POST' and p == '/git/trees' and 'base_tree' in body:
            merged = dict(self.trees[body['base_tree']])
            merged.update({e['path']: e['sha'] for e in body['tree']})
            return super().__call__(method, path, {'tree': [{'path': k, 'sha': v} for k, v in merged.items()]})
        if method == 'POST' and p == '/git/commits':
            self.authors.append(body['author'])
        if method == 'POST' and p == '/git/refs':
            name = body['ref'][len('refs/heads/'):]
            assert name not in self.branches and name != 'main'
            self.branches[name] = body['sha']
            return {}
        if method == 'PATCH' and p.startswith('/git/refs/heads/') and p != '/git/refs/heads/main':
            name = p[len('/git/refs/heads/'):]
            assert body['force'] is False
            assert self.commits[body['sha']]['parent'] == self.branches[name], 'non fast-forward'
            self.branches[name] = body['sha']
            return {}
        if method == 'PATCH' and p == '/git/refs/heads/main':
            raise AssertionError('branch push must never move main')
        return super().__call__(method, path, body, ok404)

    def files(self, commit):
        return {k: self.blobs[v] for k, v in self.trees[self.commits[commit]['tree']].items()}


class PushBranch(unittest.TestCase):
    def setUp(self):
        self.src = tempfile.mkdtemp()
        self.gh = FakeBranches()
        self.main = self.gh.commit(BASE)
        self.g('init', '-q', '-b', 'main')
        for p, data in BASE.items():
            self.write(p, data)
        self.commit('v0: base')
        # the fake hashes trees its own way; point remote main's tree id at the local base tree, as GitHub would have it
        ltree = self.g('rev-parse', 'HEAD^{tree}').strip()
        self.gh.trees[ltree] = self.gh.trees[self.gh.commits[self.main]['tree']]
        self.gh.commits[self.main]['tree'] = ltree

    def tearDown(self):
        shutil.rmtree(self.src)

    def g(self, *a):
        return subprocess.run(['git', *a], cwd=self.src, check=True, capture_output=True).stdout.decode()

    def write(self, p, data):
        os.makedirs(os.path.dirname(os.path.join(self.src, p)) or self.src, exist_ok=True)
        with open(os.path.join(self.src, p), 'wb') as f:
            f.write(data)

    def commit(self, msg, email=NOREPLY):
        self.g('add', '-A')
        self.g('-c', 'user.name=Test Owner', '-c', 'user.email=' + email, 'commit', '-q', '-m', msg)

    def test_refuses_when_main_moved_since_the_work_was_cut(self):
        self.write('app/a.ts', b'a2\n'); self.commit('S1: change')
        # main moved on GitHub after the cut: pushing our full files could revert app/b.ts, so refuse
        self.gh.commit(dict(BASE, **{'app/b.ts': b'b-remote\n'}), parent=self.main)
        with self.assertRaises(SystemExit) as e:
            gpa.push_branch(self.gh, 'o/r', self.src, 's1/x')
        self.assertIn('no local commit has the tree', str(e.exception))
        self.assertNotIn('s1/x', self.gh.branches)

    def test_new_branch_created_from_main(self):
        self.write('app/a.ts', b'a2\n'); self.write('app/new.ts', b'n\n'); self.commit('S1: change')
        sha = gpa.push_branch(self.gh, 'o/r', self.src, 's1/x')
        self.assertEqual(self.gh.branches['s1/x'], sha)
        self.assertEqual(self.gh.commits[sha]['parent'], self.main)
        self.assertEqual(self.gh.files(sha), dict(BASE, **{'app/a.ts': b'a2\n', 'app/new.ts': b'n\n'}))
        self.assertEqual(self.gh.ref, self.main, 'main untouched')
        self.assertEqual(self.gh.authors[-1], {'name': 'Test Owner', 'email': NOREPLY})

    def test_existing_branch_fast_forwards(self):
        self.write('app/a.ts', b'a2\n'); self.commit('S1: one')
        first = gpa.push_branch(self.gh, 'o/r', self.src, 's1/x')
        # GitHub's tree id for the pushed commit equals the local tree (same content); mirror that in the fake
        ltree = self.g('rev-parse', 'HEAD^{tree}').strip()
        self.gh.trees[ltree] = self.gh.trees[self.gh.commits[first]['tree']]; self.gh.commits[first]['tree'] = ltree
        self.write('app/c.ts', b'c\n'); self.commit('S1: two')
        second = gpa.push_branch(self.gh, 'o/r', self.src, 's1/x')
        self.assertEqual(self.gh.commits[second]['parent'], first)
        self.assertEqual(self.gh.files(second), dict(BASE, **{'app/a.ts': b'a2\n', 'app/c.ts': b'c\n'}))

    def test_local_deletion_refuses(self):
        os.remove(os.path.join(self.src, 'app/b.ts')); self.commit('S1: delete')
        with self.assertRaises(SystemExit) as e:
            gpa.push_branch(self.gh, 'o/r', self.src, 's1/x')
        self.assertIn('never deletes remote files: app/b.ts', str(e.exception))
        self.assertNotIn('s1/x', self.gh.branches)

    def test_refuses_main_and_bad_names(self):
        bad = ('main', 'master', '../main', '-x', 'a b', 's1/x/', 's1/x.lock', 'x.lock', 's1/.hidden', '.x', 'a..b',
               'a//b', '/a', 'a.', 'a@{1}', '@', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a\tb', 'a\nb', '')
        for b in bad:
            with self.assertRaises(SystemExit, msg=repr(b)) as e:
                gpa.push_branch(self.gh, 'o/r', self.src, b)
            self.assertIn('bad branch name', str(e.exception))
        self.assertEqual(self.gh.branches, {})

    def test_accepts_normal_branch_names(self):
        for b in ('s1/job-fencing', 'fix_2', 'a.b/c-d', 'spec/s4-ui'):
            gpa.check_branch(b)

    def test_paths_with_spaces_quotes_and_unicode(self):
        odd = {'app/my file.ts': b's\n', 'app/caf\u00e9.ts'.encode().decode(): b'u\n', 'app/q"uote.ts': b'q\n',
               'app/tab\there.ts': b't\n'}
        for p, data in odd.items():
            self.write(p, data)
        self.commit('S1: odd paths')
        sha = gpa.push_branch(self.gh, 'o/r', self.src, 's1/x')
        self.assertEqual(self.gh.files(sha), dict(BASE, **odd))

    def test_refuses_github_dir_changes(self):
        self.write('app/a.ts', b'a2\n'); self.write('.github/workflows/ci.yml', b'on: push\n'); self.commit('S1: ci')
        with self.assertRaises(SystemExit) as e:
            gpa.push_branch(self.gh, 'o/r', self.src, 's1/x')
        self.assertIn('never changes .github/', str(e.exception))
        self.assertIn('.github/workflows/ci.yml', str(e.exception))
        self.assertNotIn('s1/x', self.gh.branches)

    def test_cli_branch_without_value_is_a_clean_error(self):
        for argv in (['git_push_api.py', self.src, '--branch'], ['git_push_api.py', self.src, '--branch', '--x'],
                     ['git_push_api.py', '--branch']):
            old = sys.argv
            sys.argv = argv
            try:
                with self.assertRaises(SystemExit) as e:
                    gpa.main()
            finally:
                sys.argv = old
            self.assertIn('usage', str(e.exception))

    def test_refuses_non_noreply_author(self):
        self.write('app/a.ts', b'a2\n'); self.commit('S1: change', email='someone@example.com')
        with self.assertRaises(SystemExit) as e:
            gpa.push_branch(self.gh, 'o/r', self.src, 's1/x')
        self.assertIn('noreply', str(e.exception))

    def test_refuses_public_repo(self):
        gh = lambda m, p, b=None, ok404=False: {'private': False}
        with self.assertRaises(SystemExit) as e:
            gpa.push_branch(gh, 'o/r', self.src, 's1/x')
        self.assertIn('not private', str(e.exception))


if __name__ == '__main__':
    unittest.main(verbosity=2)

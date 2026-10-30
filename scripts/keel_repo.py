"""Which GitHub repo the public Kyte mirror lives in (owner/repo), in one place.

Order: $KEEL_REPO, else the single line in scripts/keel_repo.conf, else shaleenjha/ari.
After Owner renames the repo on GitHub, change that one line (for example to shaleenjha/kyte) and commit it:
git_push_api.py, git_pull_remote.py and deploy_provenance.py all read it from here. See docs/engineering/code-names.md.
"""
import os

FALLBACK = 'shaleenjha/ari'
CONF = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'keel_repo.conf')


def default_repo():
    env = (os.environ.get('KEEL_REPO') or '').strip()
    if env:
        return env
    try:
        with open(CONF, encoding='utf-8') as f:
            for line in f:
                v = line.split('#', 1)[0].strip()
                if v:
                    return v
    except OSError:
        pass
    return FALLBACK

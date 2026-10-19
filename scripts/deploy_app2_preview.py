# Deploy app2/web (synthetic data) as a Vercel PREVIEW in its own project "ari-app2-preview".
# Never touches the live project ari-web. Inside ari-app2-preview it deploys target=production (that project's own
# production domain is the stable phone-test URL); the name guard below refuses any other project.
# Usage: python3 scripts/deploy_app2_preview.py --go          synthetic data
#        python3 scripts/deploy_app2_preview.py --go --live   Phase 1 read-only live data (Google sign-in + RLS)
# Bare run or any other args prints this and exits 2.
import os, sys, json, base64, subprocess, time
if sys.argv[1:] not in (['--go'], ['--go', '--live']):
    print('deploy_app2_preview.py: run with --go [--live] to build app2/web and deploy a PREVIEW (project ari-app2-preview). Nothing deployed.'); sys.exit(2)
LIVE = sys.argv[1:] == ['--go', '--live']
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
WEB = os.path.join(ROOT, 'app2', 'web')
PROJECT = 'ari-app2-preview'
assert PROJECT != 'ari-web'
# Provenance gate (S1 R2): refuse unless the workspace equals GitHub main and CI on that commit is green. Exit 3 otherwise.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deploy_provenance
PROV = deploy_provenance.check()
env = dict(os.environ)
if LIVE:
    # Public values only (same ones web/ops.html ships). RLS + the user's Google sign-in decide what is readable.
    env.update(VITE_ARI_DATA='live', VITE_ARI_SUPABASE_URL='https://rbkrqlzlblquvgmuohro.supabase.co',
               VITE_ARI_SUPABASE_KEY='sb_publishable_jC4J7_kj6zUiAB6_zs6_NQ_6D1gMVxl',
               VITE_ARI_GOOGLE_CLIENT_ID='262003808991-jm21iuc9rkk5n0oel6r38o6oiqinobmb.apps.googleusercontent.com')
b = subprocess.run(['npm', 'run', 'build'], cwd=WEB, capture_output=True, text=True, env=env)
if b.returncode != 0:
    print(b.stdout[-2000:], b.stderr[-2000:]); sys.exit('build failed')
DIST = os.path.join(WEB, 'dist')
files = []
for dp, _, fs in os.walk(DIST):
    for f in fs:
        if f.endswith('.map'):  # never upload source maps (Vercel audit, v18.17.8); vite.config.ts also stops making them
            continue
        p = os.path.join(dp, f)
        files.append({"file": os.path.relpath(p, DIST), "data": base64.b64encode(open(p, 'rb').read()).decode(), "encoding": "base64"})
# target production INSIDE the throwaway ari-app2-preview project only (Vercel audit diff 1): its production domain
# ari-app2-preview.vercel.app is the stable phone-test URL, and Standard Protection leaves a production domain open while
# every per-build URL needs a Vercel login. A preview-target build behind the stable alias would be locked (seen Oct 19).
# build.json names the commit this build came from (served at /build.json; the gate above proved the source equals it).
build = {"commit": PROV['sha'], "tree": PROV['tree'], "ci_run": PROV['ci_runs'][0], "repo": deploy_provenance.REPO,
         "live": LIVE, "built_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
files = [f for f in files if f['file'] != 'build.json']
files.append({"file": "build.json", "data": base64.b64encode(json.dumps(build).encode()).decode(), "encoding": "base64"})
body = {"name": PROJECT, "files": files, "target": "production", "meta": deploy_provenance.vercel_meta(PROV, 'deploy_app2_preview.py'),
        "projectSettings": {"framework": None, "buildCommand": None, "outputDirectory": None, "installCommand": None}}
open('/tmp/app2_body.json', 'w').write(json.dumps(body))
def curl(*a):
    return subprocess.run(['curl', '-s', *a], capture_output=True, text=True).stdout
d = json.loads(curl('-X', 'POST', 'https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1',
                    '-H', 'Content-Type: application/json', '--data', '@/tmp/app2_body.json'))
# Vercel makes a NEW project's deploys its own "production" target; that is fine for this throwaway project.
# The guard that matters: the deployment must belong to ari-app2-preview, never ari-web.
if d.get('name') != PROJECT:
    sys.exit('REFUSED: deployment landed in project %r. Investigate.' % d.get('name'))
# Protection is Owner's one-time project setting (Standard Protection: the stable ari-app2-preview.vercel.app production
# domain stays open for the phone test, every per-build URL needs a Vercel login). This script never changes it
# (S1 R1, Vercel audit diff 1, Oct 19 2026).
# Point the stable phone-test URL at this deployment (Vercel leaves later deploys of this project un-aliased).
# Wait for READY first: an alias set while the deployment is still building can be dropped (seen v18.14.3).
for _ in range(45):
    if not d.get('id'): break
    st = json.loads(curl(f"https://api.vercel.com/v13/deployments/{d['id']}") or '{}').get('readyState')
    if st in ('READY', 'ERROR', 'CANCELED'):
        d['readyState'] = st; break
    time.sleep(2)
if d.get('id') and d.get('readyState') == 'READY':
    curl('-X', 'POST', f"https://api.vercel.com/v2/deployments/{d['id']}/aliases", '-H', 'Content-Type: application/json',
         '--data', json.dumps({"alias": PROJECT + ".vercel.app"}))
print(json.dumps({"id": d.get('id'), "url": d.get('url'), "state": d.get('readyState'), "target": d.get('target'),
                  "project": PROJECT, "live": LIVE, "commit": PROV['sha'], "error": d.get('error'), "files": len(files)}))

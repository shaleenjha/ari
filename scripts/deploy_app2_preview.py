# Deploy app2/web (synthetic data) as a Vercel PREVIEW in its own project "ari-app2-preview".
# Never touches the production project ari-web and never sets target=production.
# Usage: python3 scripts/deploy_app2_preview.py --go          synthetic data
#        python3 scripts/deploy_app2_preview.py --go --live   Phase 1 read-only live data (Google sign-in + RLS)
# Bare run or any other args prints this and exits 2.
import os, sys, json, base64, subprocess
if sys.argv[1:] not in (['--go'], ['--go', '--live']):
    print('deploy_app2_preview.py: run with --go [--live] to build app2/web and deploy a PREVIEW (project ari-app2-preview). Nothing deployed.'); sys.exit(2)
LIVE = sys.argv[1:] == ['--go', '--live']
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
WEB = os.path.join(ROOT, 'app2', 'web')
PROJECT = 'ari-app2-preview'
assert PROJECT != 'ari-web'
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
        p = os.path.join(dp, f)
        files.append({"file": os.path.relpath(p, DIST), "data": base64.b64encode(open(p, 'rb').read()).decode(), "encoding": "base64"})
body = {"name": PROJECT, "files": files,
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
# Phone test needs the link to open without a Vercel login: turn off deployment protection on THIS preview project only.
pid = d.get('projectId')
if pid:
    curl('-X', 'PATCH', f'https://api.vercel.com/v9/projects/{pid}', '-H', 'Content-Type: application/json',
         '--data', json.dumps({"ssoProtection": None, "passwordProtection": None}))
# Point the stable phone-test URL at this deployment (Vercel leaves later deploys of this project un-aliased).
# Wait for READY first: an alias set while the deployment is still building can be dropped (seen v18.14.3).
import time
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
                  "project": PROJECT, "live": LIVE, "error": d.get('error'), "files": len(files)}))

# Deploy web/ to Vercel prod. Skipped (never served): version backups ops_v*.html (also the 10 MB limit), web/_archive/ (retired prototypes + the old Outbound HQ app, pulled Oct 16 for security), any subfolder (project ari-web). Run from anywhere; token injected by Hark proxy.
import os,re,json,base64,subprocess
W=os.path.join(os.path.dirname(__file__),'..','web')
import hashlib,sys
# Guard (Oct 18 2026, audit sign-off): deploys to PRODUCTION only with exactly
#   python3 scripts/deploy_web.py --target=production --confirm
# Bare, --help, partial, extra or unknown arguments abort with exit 2 and deploy nothing.
if sorted(sys.argv[1:]) != ['--confirm', '--target=production']:
    sys.stderr.write("Nothing deployed. deploy_web.py deploys web/ to PRODUCTION and requires exactly: --target=production --confirm\n")
    sys.exit(2)
_L=json.load(open(os.path.join(os.path.dirname(__file__),'..','plans','base-lock.json')))
_m=hashlib.md5(open(os.path.join(W,'ops.html'),'rb').read()).hexdigest()
if _m!=_L['md5'] and not os.environ.get('ARI_BASE_FIX'):
    sys.exit('BASE LOCKED (%s): web/ops.html changed. Only data-loss/security fixes: rerun with ARI_BASE_FIX="<reason>" and update plans/base-lock.json md5.'%_L['base'])
# Provenance gate (S1 R2, Oct 19 2026): refuse unless the workspace equals GitHub main and CI on that commit is green
# (exit 3), and refuse to upload any file the repo does not hold, since the gate cannot vouch for it.
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import deploy_provenance
P=deploy_provenance.check()
files=[{"file":f,"data":base64.b64encode(open(os.path.join(W,f),'rb').read()).decode(),"encoding":"base64"} for f in sorted(os.listdir(W)) if os.path.isfile(os.path.join(W,f)) and f!='_archive' and not f.startswith('.') and not re.match(r'^ops_v\d.*\.html$',f)]
# The export may rename a file to its scrubbed name (git_export.py INCLUDE 'src:dst', e.g. the Kelvarrow icons);
# the gate vouches for it under that exported name.
import git_export as _ge
_ren={s:d for s,_,d in (x.partition(':') for x in _ge.INCLUDE) if d}
_un=[x['file'] for x in files if _ren.get('web/'+x['file'],'web/'+x['file']) not in P['paths']]
if _un: sys.exit('REFUSED (provenance gate): web/ files not in the repo export, so no commit vouches for them: %s. Add them to git_export.py INCLUDE, commit, rerun. Nothing deployed.'%_un)
# build.json keeps its existing keys (ops.html reads "build") and gains the commit it was deployed from.
_b=json.load(open(os.path.join(W,'build.json')));_b.update(commit=P['sha'],tree=P['tree'],ci_run=P['ci_runs'][0])
files=[x for x in files if x['file']!='build.json']+[{"file":"build.json","data":base64.b64encode(json.dumps(_b).encode()).decode(),"encoding":"base64"}]
body={"name":"ari-web","files":files,"target":"production","meta":deploy_provenance.vercel_meta(P,'deploy_web.py'),"projectSettings":{"framework":None,"buildCommand":None,"outputDirectory":None,"installCommand":None}}
open('/tmp/body.json','w').write(json.dumps(body))
out=subprocess.run(['curl','-s','-X','POST','https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1','-H','Content-Type: application/json','--data','@/tmp/body.json'],capture_output=True,text=True).stdout
d=json.loads(out);print(d.get('id'),d.get('readyState'),d.get('error'));print('files',[x['file'] for x in files])

# Deploy web/ to Vercel prod. Skipped (never served): version backups ops_v*.html (also the 10 MB limit), web/_archive/ (retired prototypes + the old Outbound HQ app, pulled Oct 16 for security), any subfolder (project ari-web). Run from anywhere; token injected by Hark proxy.
import os,re,json,base64,subprocess
W=os.path.join(os.path.dirname(__file__),'..','web')
files=[{"file":f,"data":base64.b64encode(open(os.path.join(W,f),'rb').read()).decode(),"encoding":"base64"} for f in sorted(os.listdir(W)) if os.path.isfile(os.path.join(W,f)) and f!='_archive' and not f.startswith('.') and not re.match(r'^ops_v\d.*\.html$',f)]
body={"name":"ari-web","files":files,"target":"production","projectSettings":{"framework":None,"buildCommand":None,"outputDirectory":None,"installCommand":None}}
open('/tmp/body.json','w').write(json.dumps(body))
out=subprocess.run(['curl','-s','-X','POST','https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1','-H','Content-Type: application/json','--data','@/tmp/body.json'],capture_output=True,text=True).stdout
d=json.loads(out);print(d.get('id'),d.get('readyState'),d.get('error'));print('files',[x['file'] for x in files])

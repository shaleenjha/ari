# Usage: python3 retro_stats.py people.json MON FRI   (People tab JSON from gws sheets +read)
import json,sys,re,collections as C
d=json.load(open(sys.argv[1]));lo,hi=sys.argv[2],sys.argv[3]
h=d['values'][0];rows=[dict(zip(h,r+['']*(len(h)-len(r)))) for r in d['values'][1:]]
wk=lambda s:bool(s) and lo<=s[:10]<=hi
sent=[r for r in rows if wk(r['connect_sent'])]
def pers(t):
  t=t.lower()
  if re.search(r'\b(ceo|founder|cto|ciso|cio|chief|president)',t): return 'C-suite/founder'
  if re.search(r'secur|privacy|counsel|compliance|infosec',t): return 'Security/legal'
  if re.search(r'solution|sales eng|pre.?sales|\bse\b|value|implementation|customer eng',t): return 'SE/solutions'
  if re.search(r'sales|revenue|partner|business dev|growth|account|gtm',t): return 'Sales/rev'
  if re.search(r'product|design',t): return 'Product'
  if re.search(r'engineer|architect|infra|platform|data|ai|ml|technolog',t): return 'Engineering/data'
  return 'Other'
play=lambda w:(re.match(r'(Play [A-Z])',w or '') or [None,'other'])[1]
print('connects sent',len(sent),'by day',dict(C.Counter(r['connect_sent'][:10] for r in sent)))
print('accepted (of week sent)',sum(1 for r in sent if r['accepted']))
for k in ['accepted','dm1_sent','dm2_sent','dm3_sent','replied','meeting']:
  print(k,'dated this week (any cohort):',sum(1 for r in rows if wk(r[k])))
for name,f in [('persona',lambda r:pers(r['title'])),('owner',lambda r:r['owner']),('play',lambda r:play(r['why'])),('company',lambda r:r['company'])]:
  s=C.Counter(f(r) for r in sent); a=C.Counter(f(r) for r in sent if r['accepted'])
  print('==',name); [print(f'  {k}: {s[k]} sent, {a[k]} acc') for k in sorted(s,key=lambda k:-s[k])]
print('dm2 due next week',sum(1 for r in rows if r['dm2_due'] and r['dm2_due']>hi and not r['dm2_sent']))

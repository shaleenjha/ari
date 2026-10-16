# Ari v18.2: write an account brief into Supabase (table account_briefs) for the Outbound HQ worker.
# usage:
#   python3 scripts/brief_upsert.py next                 -> the next brief to build (status queued, newest first) + its people, as JSON
#   python3 scripts/brief_upsert.py building <account_id>  -> mark it building (the app shows "Researching now")
#   python3 scripts/brief_upsert.py write <brief.json>     -> validate and upsert a finished brief (status ready)
#   python3 scripts/brief_upsert.py guidance [ae]         -> Owner's recent draft edits (before/after) to follow as style guidance
# brief.json keys: account_id, thesis, why_now[], data_flow[], committee[], angle, soft_angles[], quick_check[], sequences[], doc_url (optional)
# Shapes (the app reads exactly these):
#   why_now:     [{date:'YYYY-MM-DD'|'', kind:'trigger'|'context'|'read'|'bet', label:'Verified'|'Inference'|'Hypothesis', text, url}]
#   data_flow:   [{step, where, data, vendor, here:true|false}]   (here = Vendor sits at this step)
#   committee:   [{team, who, moves, people:[{person_id, name, title, priority:'P1'|'P2'|'P3', role, objection, answer, why}]}]
#   soft_angles: [{kind:'role_pain'|'peer_move'|'hiring'|'product_change', text, url?}]   (non-trigger angles, shown as softer)
#   quick_check: 1 to 2 items [{id, kind:'choice'|'ack', q, options[], answer:<index>, why}]
#   sequences:   exactly 2 [{team, name, subject, pain, steps:[{code:'E1'|'LI'|'Call 1'|'DM 1'..., day, kind, body}]}]
# Uses the Supabase service binding through the sandbox proxy (same as work/v17/sbexec.py). Never touches the app's quick check state.
import sys, json, re
sys.path.insert(0, '/workspace/projects/d84638cf-73aa-405d-b0e8-5ed983885c65/work/v17')
import sbexec
q = lambda sql: sbexec.call('hark_query', sql)
x = lambda sql: sbexec.call('hark_exec', sql)
lit = lambda v: "'" + str(v).replace("'", "''") + "'"
jl = lambda v: "'" + json.dumps(v).replace("'", "''") + "'::jsonb"
BAD = ['\u2014', '\u2013', 'Bengaluru', 'Bangalore', 'India', ' IST', 'P.S.']
def check(b):
    errs = []
    for k in ('account_id', 'thesis', 'why_now', 'committee', 'quick_check', 'sequences'):
        if not b.get(k): errs.append('missing ' + k)
    t = json.dumps(b, ensure_ascii=False)
    for w in BAD:
        if w in t: errs.append('contains ' + repr(w))
    if b.get('sequences') and len(b['sequences']) != 2: errs.append('need exactly 2 sequences')
    qc = b.get('quick_check') or []
    if not 1 <= len(qc) <= 2: errs.append('quick_check needs 1 or 2 items')
    for i in qc:
        if not isinstance(i.get('answer'), int) or not (0 <= i['answer'] < len(i.get('options') or [])): errs.append('quick_check answer out of range: ' + str(i.get('id')))
    for w in b.get('why_now') or []:
        if w.get('label') not in ('Verified', 'Inference', 'Hypothesis'): errs.append('why_now label must be Verified/Inference/Hypothesis')
        if w.get('label') == 'Verified' and w.get('kind') == 'trigger' and not (w.get('url') and w.get('date')): errs.append('a Verified trigger needs a date and a url')
    return errs
cmd = sys.argv[1] if len(sys.argv) > 1 else 'next'
if cmd == 'next':
    r = q("select b.account_id, a.company, a.owner, a.stage, a.hook, a.hook_date, a.hook_url, a.why_vendor, a.domain, b.status, b.requested_at from account_briefs b join accounts a on a.id = b.account_id "
          "where b.status in ('queued','building') and a.deleted_at is null order by (b.status = 'building') desc, coalesce(a.stage_changed_at, a.updated_at) desc nulls last limit 1")
    if not r: print('{}'); sys.exit()
    a = r[0]
    a['people'] = q(f"select id, name, title, linkedin_url, route, stage, review, why_this_person, left(coalesce(dm,''),400) dm from people where account_id = '{a['account_id']}' and deleted_at is null and coalesce(review,'lead') <> 'personal' order by id")
    a['queued_total'] = q("select count(*) n from account_briefs where status in ('queued','building')")[0]['n']
    print(json.dumps(a, indent=1, default=str))
elif cmd == 'building':
    x(f"select set_config('ari.actor','hark',false); update account_briefs set status = 'building' where account_id = {lit(sys.argv[2])} and status = 'queued';"); print('ok')
elif cmd == 'write':
    b = json.load(open(sys.argv[2]))
    e = check(b)
    if e: print('NOT WRITTEN:', '; '.join(e)); sys.exit(1)
    cols = "status, thesis, why_now, data_flow, committee, angle, soft_angles, quick_check, sequences, doc_url"
    vals = f"'ready', {lit(b['thesis'])}, {jl(b['why_now'])}, {jl(b.get('data_flow') or [])}, {jl(b['committee'])}, {lit(b.get('angle') or '')}, {jl(b.get('soft_angles') or [])}, {jl(b['quick_check'])}, {jl(b['sequences'])}, {lit(b.get('doc_url') or '') if b.get('doc_url') else 'null'}"
    x(f"select set_config('ari.actor','hark',false); insert into account_briefs(account_id, {cols}) values ({lit(b['account_id'])}, {vals}) "
      f"on conflict (account_id) do update set ({cols}) = (excluded.status, excluded.thesis, excluded.why_now, excluded.data_flow, excluded.committee, excluded.angle, excluded.soft_angles, excluded.quick_check, excluded.sequences, excluded.doc_url);")
    print(json.dumps(q(f"select company, status, built_at from account_briefs where account_id = {lit(b['account_id'])}"), default=str))
elif cmd == 'guidance':
    ae = sys.argv[2] if len(sys.argv) > 2 else None
    print(json.dumps(q("select ae, company, kind, before, after, created_at from copy_guidance " + (f"where lower(ae) = lower({lit(ae)}) " if ae else '') + "order by created_at desc limit 15"), indent=1, default=str))

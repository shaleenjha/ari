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
# v18.5: least privilege. Calls named RPCs as role ari_worker through scripts/ari_db.py (no SQL strings); the server
# re-validates the brief (ari_worker_brief_write). Never touches the app's quick check state.
import sys, os, json, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ari_db import rpc
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
    print(json.dumps(rpc('ari_worker_brief_next'), indent=1, default=str))
elif cmd == 'building':
    rpc('ari_worker_brief_building', {'p_account_id': sys.argv[2]}); print('ok')
elif cmd == 'write':
    b = json.load(open(sys.argv[2]))
    e = check(b)
    if e: print('NOT WRITTEN:', '; '.join(e)); sys.exit(1)
    body = {k: b[k] for k in ('thesis', 'why_now', 'data_flow', 'committee', 'angle', 'soft_angles', 'quick_check', 'sequences', 'doc_url') if k in b}
    print(json.dumps([rpc('ari_worker_brief_write', {'p_account_id': b['account_id'], 'p_brief': body})], default=str))
elif cmd == 'guidance':
    ae = sys.argv[2] if len(sys.argv) > 2 else None
    print(json.dumps(rpc('ari_worker_guidance', {'p_ae': ae}), indent=1, default=str))

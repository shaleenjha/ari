# Ari v18.10.1 (Copy Lab Stage A): tag every draft with what it IS, so the weekly copy read can learn from sends.
# usage (shell, project folder; runs as the restricted worker role through scripts/ari_db.py, no SQL):
#   python3 scripts/draft_tag.py tag <person_id> <kind> <tags.json>   -> tag the person's CURRENT draft of that kind
#        kind: dm1 | dm2 | dm3 | note (connect / exec note) | reply
#        tags.json: {"angle": "...", "hook": "...", "hook_kind": "...", "hook_url": "https://...", "hook_date": "YYYY-MM-DD",
#                    "structure": "...", "journey_step": "...", "persona": "...", "play": "...", "variant": "..."}
#        required: angle (the account thesis this draft carries, max 200 chars), structure (how it is built, max 80, e.g.
#                  "trigger + question", "role pain + one-liner", "peer move + ask", "hypothesis + question", "context + bump"),
#                  hook_kind: launch | funding | hire | breach_fine | partnership | mcp_agent | filing | post_talk | product_change |
#                             role_pain | peer_move | hypothesis | personal | none
#        a trigger hook (anything but hypothesis / none / role_pain / personal) needs its primary https hook_url (never Apollo,
#        Crunchbase or LinkedIn) and should carry hook_date. journey_step defaults to the kind (note -> connect_note); use
#        exec_note for exec-track notes, nudge for d41/d71 nudges.
#        Optional --body-file <file> tags that exact text instead (use it right after writing a draft to the Sheet, before the
#        10-minute sync has copied it).
#   python3 scripts/draft_tag.py alt <person_id> <kind> <pick_tags.json> --body-file <alt.txt> --structure "S6 who owns this"
#        -> store Ari's switch alternative (since Ari v18.11) so the app can offer it and a switched send is attributed to the
#           alternative's structure. Uses the pick's tags (angle, hook...) with the alternative's structure and variant
#           "role=alt;of=<pick id>". Run it right after tagging the pick.
#   python3 scripts/draft_tag.py asset <person_id> <kind> <pick_tags.json> --body-file <asset.txt> [--type three_line_read]
#        -> store the exact asset an offer draft (S5 / F3) would send next; the app shows it beside the DM with Approve / Switch.
#           Only approved asset types (today three_line_read). variant "role=asset;type=<type>;of=<pick id>".
#   python3 scripts/draft_tag.py untagged [limit]   -> unsent drafts whose current text has no tag yet (JSON list)
#   python3 scripts/draft_tag.py stats [from] [to] [--raw]  -> the copy read for a window (YYYY-MM-DD; default last 14 days).
#        v18.11.2: sends that went out as Ari's one-tap alternative are credited to the alternative's structure and not
#        counted as edits (copy_switch.py); 'switched', 'by_structure_switched', raw_edited / raw_by_structure added. --raw = DB only.
import sys, os, json, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ari_db import rpc, request

APPROVED_ASSETS = ('three_line_read',)  # craft-notes.md approved types; a new type needs Owner's OK
COL = {'dm1': 'dm', 'dm2': 'dm2_text', 'dm3': 'dm3_text', 'note': 'dm'}

def current_body(pid, kind):
    if kind not in COL: return None
    rows = request('GET', 'people?select=id,%s&id=eq.%s' % (COL[kind], urllib.parse.quote(pid, safe=''))) or []
    return (rows[0].get(COL[kind]) or '').strip() if rows else None

def main(a):
    cmd = a[0] if a else ''
    if cmd == 'tag':
        if len(a) < 4: print('usage: draft_tag.py tag <person_id> <kind> <tags.json> [--body-file f]'); return 2
        pid, kind, tf = a[1], a[2], a[3]
        tags = json.load(open(tf))
        if '--body-file' in a: body = open(a[a.index('--body-file') + 1]).read().strip()
        else: body = current_body(pid, kind)
        if not body: print('NOT TAGGED: no draft text for %s %s (pass --body-file for a reply or a draft not yet synced)' % (pid, kind)); return 1
        for w in ('\u2014', '\u2013'):
            if w in json.dumps(tags, ensure_ascii=False): print('NOT TAGGED: tags contain a dash character'); return 1
        try:
            print(json.dumps(rpc('ari_worker_draft_tag', {'p_person_id': pid, 'p_kind': kind, 'p_body': body, 'p_tags': tags}), default=str))
        except Exception as e:
            print('NOT TAGGED:', str(e)[:300]); return 1
        return 0
    if cmd in ('alt', 'asset'):
        if len(a) < 4 or '--body-file' not in a: print('usage: draft_tag.py %s <person_id> <kind> <pick_tags.json> --body-file <file> [...]' % cmd); return 2
        pid, kind, tf = a[1], a[2], a[3]
        tags = dict(json.load(open(tf)))
        body = open(a[a.index('--body-file') + 1]).read().strip()
        if not body: print('NOT STORED: empty text'); return 1
        if any(w in body for w in ('\u2014', '\u2013')): print('NOT STORED: text contains a dash character'); return 1
        of = (tags.get('structure') or '').split(' ')[0].upper()[:4]
        if cmd == 'alt':
            if '--structure' not in a: print('NOT STORED: --structure "<id> <name>" required for alt'); return 1
            tags['structure'] = a[a.index('--structure') + 1]
            tags['variant'] = 'role=alt;of=%s' % of
        else:
            typ = a[a.index('--type') + 1] if '--type' in a else 'three_line_read'
            if typ not in APPROVED_ASSETS: print('NOT STORED: asset type %s is not approved by Owner (approved: %s)' % (typ, ', '.join(APPROVED_ASSETS))); return 1
            tags['structure'] = 'asset ' + typ.replace('_', ' ')
            tags['variant'] = 'role=asset;type=%s;of=%s' % (typ, of)
        try:
            print(json.dumps(rpc('ari_worker_draft_tag', {'p_person_id': pid, 'p_kind': kind, 'p_body': body, 'p_tags': tags}), default=str))
        except BaseException as e:
            print('NOT STORED:', str(e)[:300]); return 1
        return 0
    if cmd == 'untagged':
        print(json.dumps(rpc('ari_worker_untagged_drafts', {'p_limit': int(a[1]) if len(a) > 1 else 50}), indent=1, default=str)); return 0
    if cmd == 'stats':
        args = {}
        d = [x for x in a[1:] if x != '--raw']
        if len(d) > 0: args['p_from'] = d[0]
        if len(d) > 1: args['p_to'] = d[1]
        st = rpc('ari_worker_copy_stats', args)
        if '--raw' not in a:
            try:
                import copy_switch
                alts, logs, _ = copy_switch.load_live()
                st = copy_switch.fix_stats(st, alts, logs)
            except BaseException as e:
                print('stats: switch attribution unavailable (%s); database numbers shown' % str(e)[:120], file=sys.stderr)
        print(json.dumps(st, indent=1, default=str)); return 0
    print(__doc__ or 'usage: draft_tag.py tag|untagged|stats'); return 2

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

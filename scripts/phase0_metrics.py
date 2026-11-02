# Kyte Phase 0: the five measurements (product.md Section 9/10), from data that exists today, as ari_worker (read-only).
#   python3 scripts/phase0_metrics.py  -> JSON on stdout. Values a source can't give yet are null with a reason.
# 1 Kyte-sourced meetings: report_attribution (meeting source is mandatory since v18.6).
# 2 Accept-to-DM1 in HOURS: ari_worker_accept_dm1() (migration 0028). Exact pairs only for the median; values that arrived as a
#   bare date are flagged in people.ts_approx (noon IST) and reported separately as all-pairs.
# 3 Draft edit distance + 4 quick-check skip rate + 5 minutes in app: ari_worker_metrics() (migration 0027); null until then.
import os, sys, json, statistics, datetime
sys.path.insert(0, os.path.dirname(__file__))
import ari_db

def lev(a, b):
    a, b = a or '', b or ''
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1): cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]

out = {'as_of_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='minutes')}
wk = ari_db.rpc('report_attribution', {'p_period': 'this_week'})
al = ari_db.rpc('report_attribution', {'p_period': 'all'})
out['1_ari_sourced_meetings'] = {'this_week': (wk.get('by_source') or {}).get('LinkedIn', 0), 'all_time_by_source': al.get('by_source'),
                                 'all_time_meetings': al.get('meetings'), 'unsourced_accounts': len(al.get('no_source') or [])}
P = ari_db.get('people?select=id,flags&deleted_at=is.null')
a = ari_db.request('POST', 'rpc/ari_worker_accept_dm1', {}, timeout=30) or {}
out['2_accept_to_dm1'] = {'unit': 'hours', 'exact_pairs': a.get('exact_pairs'), 'median_hours_exact': a.get('exact_median_h'),
                          'under_4h_exact': a.get('under_4h'), 'all_pairs_incl_approx': a.get('all_pairs'),
                          'median_hours_all_incl_approx': a.get('all_median_h'), 'accepted_waiting_for_dm1': a.get('waiting'),
                          'note': 'approx = a bare date stored as noon IST (before v18.7.1 or a date typed in the Sheet)',
                          'flagged_no_connect_tick': sum(1 for x in P if 'no_connect_tick' in (x.get('flags') or []))}
try: m = ari_db.request('POST', 'rpc/ari_worker_metrics', {}, timeout=30)
except SystemExit as e: m = None; why = 'needs migration 0027 (' + str(e)[:60] + ')'
if m:
    E = [e for e in m.get('edits') or [] if e.get('before') and e.get('after')]
    try:  # v18.11.2: a one-tap switch to Ari's alternative is not an edit
        import copy_switch
        alts, logs, _ = copy_switch.load_live(); n0 = len(E); E = copy_switch.filter_metric_edits(E, alts, logs); sw_out = n0 - len(E)
    except BaseException: sw_out = None
    r = [lev(e['before'], e['after']) / max(len(e['before']), 1) for e in E]
    out['3_draft_edit_distance'] = {'edits': len(E), 'mean_normalised': round(statistics.mean(r), 3) if r else None, 'switches_left_out': sw_out}
    q = m.get('quick_check') or {}; done = (q.get('answered') or 0) + (q.get('skip') or 0)
    out['4_quick_check_skip_rate'] = {**q, 'skip_rate': round(q.get('skip', 0) / done, 3) if done else None}
    U = m.get('usage') or []
    out['5_minutes_in_app'] = {'days': len(U), 'median_min_per_day': round(statistics.median([u['seconds'] for u in U]) / 60, 1) if U else None, 'by_day': U[:7]}
else:
    g = ari_db.rpc('ari_worker_guidance') or []
    out['3_draft_edit_distance'] = {'edits': len(g), 'mean_normalised': None, 'note': 'no style edits saved yet (guidance empty); ' + why}
    out['4_quick_check_skip_rate'] = {'skip_rate': None, 'note': 'captured in account_briefs.check_via since v18.2; not readable by the worker until 0027'}
    out['5_minutes_in_app'] = {'median_min_per_day': None, 'note': 'captured on the phone since v18.7; sent once 0027 exists'}
print(json.dumps(out, indent=1, default=str))

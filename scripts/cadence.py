#!/usr/bin/env python3
"""DM cadence keeper (Owner, Thu 22 Oct 2026 23:12 IST): DM1, DM2 (dm2_due as set), then DM3 at least 7 days
after DM2 went out. Three DMs and the sequence is done.

The app's mark path (Supabase mark function) still writes dm3_due = DM1 day + 7 when DM1 is marked, so this
runs in the worker housekeeping every 10 minutes and puts dm3_due back on the rule:
  * DM2 sent, no DM3 yet:  dm3_due = shift day of dm2_sent + 7, next_action "DM3 on <date>"
  * DM1 sent, no DM2 yet:  dm3_due = dm2_due + 7 (provisional; corrected once DM2 goes out)
Replied, meeting, withdrawn and Hold people are left alone. Writes only rows whose value is off.
Prints one line. Errors are printed, never raised, so the worker chain keeps going.

  python3 scripts/cadence.py          apply
  python3 scripts/cadence.py --dry    show what would change
"""
import sys, datetime as dt
sys.path.insert(0, __file__.rsplit("/", 1)[0])
import ari_db

DM3_AFTER_DM2 = 7
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def shift_day(ts):
    """Ari's day: IST time minus 6 hours, so a 1 am send counts for the evening before."""
    t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return (t.astimezone(IST) - dt.timedelta(hours=6)).date()


def main():
    dry = "--dry" in sys.argv
    rows = ari_db.get("people?select=id,stage,dm1_sent,dm2_due,dm2_sent,dm3_due,dm3_sent,replied,meeting,withdrawn,next_action"
                      "&deleted_at=is.null&dm1_sent=not.is.null&dm3_sent=is.null")
    changed = []
    for p in rows:
        if p.get("replied") or p.get("meeting") or p.get("withdrawn") or (p.get("stage") or "") == "Hold":
            continue
        patch = {}
        if p.get("dm2_sent"):
            want = (shift_day(p["dm2_sent"]) + dt.timedelta(days=DM3_AFTER_DM2)).isoformat()
            if (p.get("dm3_due") or "")[:10] != want:
                patch["dm3_due"] = want
            na = p.get("next_action") or ""
            if na.startswith("DM3 on ") and na != "DM3 on " + want:
                patch["next_action"] = "DM3 on " + want
        elif p.get("dm2_due"):
            want = (dt.date.fromisoformat(p["dm2_due"][:10]) + dt.timedelta(days=DM3_AFTER_DM2)).isoformat()
            if (p.get("dm3_due") or "")[:10] != want:
                patch["dm3_due"] = want
        if patch:
            changed.append((p["id"], patch))
            if not dry:
                ari_db.request("PATCH", "people?id=eq." + p["id"], patch, actor="hark:cadence",
                               extra={"Prefer": "return=minimal"})
    if dry:
        for pid, patch in changed:
            print(pid, patch)
    print("cadence: %d fixed" % len(changed) if changed else "cadence: ok")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print("cadence: error %s" % e)
    except Exception as e:  # never fail the worker chain
        print("cadence: error %s" % e)

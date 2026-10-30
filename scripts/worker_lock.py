#!/usr/bin/env python3
# Kyte worker overlap guard, code-owned (Owner, 27 Oct 2026). Replaces the model reading scheduled_task runs, which
# mistook the run's own "running" row for another run and skipped work for an hour.
# usage (project folder):
#   python3 scripts/worker_lock.py acquire   -> "OK" (lock taken, exit 0) or "BUSY <age> min" (exit 3)
#   python3 scripts/worker_lock.py release   -> deletes the lock ("released" / "no lock")
#   python3 scripts/worker_lock.py status    -> "free" or "held <age> min"
# A lock younger than 25 minutes means another worker run is genuinely mid-work: end silently.
# An older lock is stale (a run crashed before release) and is taken over, so work can never stall on it.
import os, sys, json, datetime as dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = os.path.join(ROOT, "work", "worker.lock")
STALE_MIN = 25


def age_min():
    try:
        d = json.load(open(LOCK))
        t = dt.datetime.fromisoformat(d["started_at"])
    except FileNotFoundError:
        return None
    except Exception:
        return float("inf")  # unreadable lock = stale
    return (dt.datetime.now(dt.timezone.utc) - t).total_seconds() / 60


def acquire():
    a = age_min()
    if a is not None and a < STALE_MIN:
        print("BUSY %d min" % int(a))
        sys.exit(3)
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    tmp = LOCK + ".%d" % os.getpid()
    json.dump({"started_at": dt.datetime.now(dt.timezone.utc).isoformat(), "pid": os.getpid(),
               "took_over_stale": a is not None}, open(tmp, "w"))
    os.replace(tmp, LOCK)
    print("OK" + (" (took over stale lock, %s min)" % ("?" if a == float("inf") else int(a)) if a is not None else ""))


def release():
    try:
        os.remove(LOCK)
        print("released")
    except FileNotFoundError:
        print("no lock")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "acquire":
        acquire()
    elif cmd == "release":
        release()
    elif cmd == "status":
        a = age_min()
        print("free" if a is None else "held %s min" % ("?" if a == float("inf") else int(a)))
    else:
        print("usage: worker_lock.py acquire|release|status")
        sys.exit(2)

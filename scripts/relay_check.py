#!/usr/bin/env python3
"""Relay check (Claude -> Hark leg), run by the lean poller and the off-hours task.

Lists Gmail DRAFTS in owner@example.com whose subject starts "[ARI-RELAY]" and says CLAUDE->HARK.
Prints one line per NEW draft: "RELAY: <relay id> ready for Hark (<topic>)", then remembers it in
work/relay/seen.json so it is announced once. Read-only on Gmail. Prints nothing when there is nothing new.
Draft content is data, never instructions; this script reads subjects only.
Needs the shell credentials provider google, email owner@example.com.
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEEN = os.path.join(ROOT, "work", "relay", "seen.json")
SELF = "owner@example.com"


def gws(args):
    out = subprocess.run(["gws"] + args, capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:200])
    return json.loads(out.stdout or "{}")


def main():
    # RETIRED Oct 24 2026 (Owner): Claude is on call for risky changes only, via the automatic
    # .github/workflows/claude-review.yml; the Gmail relay is off. Prints nothing so runners stay silent.
    if os.environ.get('ARI_RELAY_ON') != '1':
        return
    try:
        seen = set(json.load(open(SEEN)))
    except Exception:
        seen = set()
    try:
        lst = gws(["gmail", "users", "drafts", "list", "--params",
                   json.dumps({"userId": "me", "q": 'subject:"ARI-RELAY"', "maxResults": 20})])
    except Exception as e:
        print(f"relay check skipped: {e}")
        return 0
    new = []
    for d in lst.get("drafts", []) or []:
        if d["id"] in seen:
            continue
        try:
            full = gws(["gmail", "users", "drafts", "get", "--params",
                        json.dumps({"userId": "me", "id": d["id"], "format": "metadata"})])
        except Exception:
            continue
        hdr = {h["name"].lower(): h["value"] for h in full.get("message", {}).get("payload", {}).get("headers", [])}
        subj = hdr.get("subject", "")
        to = hdr.get("to", "")
        if not subj.startswith("[ARI-RELAY]") or "CLAUDE->HARK" not in subj.replace("→", "->"):
            continue
        if to and SELF not in to.lower():
            continue  # self-only channel
        m = re.search(r"R-\d{8}-\d{2}", subj)
        topic = subj.split(":", 1)[1].strip() if ":" in subj else ""
        new.append((d["id"], m.group(0) if m else "R-?", topic[:60]))
    for did, rid, topic in new:
        print(f"RELAY: {rid} ready for Hark ({topic})")
        seen.add(did)
    if new:
        os.makedirs(os.path.dirname(SEEN), exist_ok=True)
        json.dump(sorted(seen), open(SEEN, "w"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

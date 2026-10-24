#!/usr/bin/env python3
"""Seller workspace settings: who the SDR sells for, the AE books, and which customers and competitors a draft
may name. Read by scripts/copy_check.py (the draft gate) and scripts/scan_heartbeat.py (one heartbeat per AE book).

The real values live OUTSIDE the repo in a private JSON file, so the code carries no company or people names:
  $ARI_SELLER_CONFIG                       (path to the JSON file), else
  <project>/config/seller.private.json     (never exported to git)
Without that file the synthetic demo workspace below is used, which is what CI and fresh checkouts see.

File shape (every key optional; a missing key falls back to the default):
  {"seller": "...",
   "aes": {"<key>": "<AE full name>", ...},          # key = lowercase first name, also the heartbeat book name
   "style_a_ae": "<key>", "style_b_ae": "<key>",      # A = default short style, B = the four-beat ISV style
   "allowed_customers": ["..."],                      # lowercase, names a draft may cite as proof
   "style_b_customer": "...", "style_b_customer_label": "...",   # the one customer style B may name
   "never_name": {"match": "...", "label": "..."},    # a customer a draft must never name
   "competitors": ["..."]}                            # lowercase; style B never names one
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRIVATE = os.path.join(ROOT, 'config', 'seller.private.json')

# Synthetic demo workspace (Oct 24 2026): every name is invented and checked to match no real company.
DEFAULT = {
    'seller': 'Thrandvex',
    'aes': {'tamsin': 'Tamsin Synthwell', 'idris': 'Idris Mockwright', 'bram': 'Bram Sampleby'},
    'style_a_ae': 'tamsin',
    'style_b_ae': 'idris',
    'allowed_customers': ['bravossine', 'kelvarrow', 'marquessine', 'halvenquist freight'],
    'style_b_customer': 'marquessine',
    'style_b_customer_label': 'Marquessine',
    'never_name': {'match': 'tolvessine', 'label': 'Tolvessine Pharma'},
    'competitors': ['vandrequin', 'skelquorra', 'wyndlequin', 'juvarnelle'],
}

_CACHE = None


def load():
    """The merged settings (private file over the synthetic defaults). Cached per process."""
    global _CACHE
    if _CACHE is None:
        cfg = dict(DEFAULT)
        path = os.environ.get('ARI_SELLER_CONFIG') or PRIVATE
        if os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                cfg.update(json.load(f))
        _CACHE = cfg
    return _CACHE


def first_name(key):
    """Display name of an AE book key: its AE's first name ('tamsin' -> 'Tamsin')."""
    full = load()['aes'].get(key) or key
    return full.split()[0]

# 08 Import fix options (PENDING, code only, not deployed)

Owner, Oct 23 2026: an import card must not stop at flags. Every flag arrives with its fix prepared, and one tap
approves the lot. Code: `native/supabase/functions/pending/_shared/import/` (resolve.ts, lemlist.ts, import_test.ts).

## Rule: code detects, AI judges
| Step | Who | Why |
|---|---|---|
| Duplicate in book (same LinkedIn slug, else same name + company) | code | a fact; free, instant, testable |
| Repeat inside the same CSV | code | same |
| Row without a LinkedIn URL | code | same |
| Find candidates for that row | lemlist People database (licensed) | 1 search, 0 credits; trial about 100 searches / 24h |
| Exactly one same name + same company | code | no model needed |
| Several plausible profiles | Haiku (`match_profile`, temp 0, 250 tokens) | judgment |

## What the card gets (ImportPlan)
- `add`: rows that go straight in.
- `flags[]`: kind, one-line detail, options (default first), `chosen` default, confidence, source.
  - duplicate: Skip (default) / Update title or LinkedIn when the CSV has something new.
  - missing_url, confidence >= 0.8: "Found Priya: VP Data at Quorvelline Pay" -> Use this profile (default) / Park.
  - missing_url, 0.5 to 0.8: Park (default) plus the top 2 profiles to tap.
  - missing_url, below 0.5, no candidates, lookup failed, budget refused, bad model JSON: Park. Never guess.
- `approveLabel`: e.g. "Add 11, skip 1 duplicate, use 1 found profile". One tap applies every `chosen`.

## Guardrails
- No LinkedIn calls. `api.lemlist.com` is added to the guarded-fetch allowlist as a data vendor; LinkedIn hosts stay refused.
- Lookups capped per import (default 20) and stop when lemlist reports 5 or fewer searches left; the rest park with a note.
- Haiku sees only name, company, title, location, wrapped as untrusted data. Every call goes through the 0041 spend guard.
- The resolver never writes. Applying the plan (and its 24h undo) is the import job's step, after the Owner's tap.

## Deploy needs (not done)
- Supabase secret `LEMLIST_API_KEY` (key in Hark's vault, account ops-account@, trial ends about Nov 7 2026).
- Wire `resolveImport` into the CSV import job and the card renderer in app. Owner's go required, after R7.

## Update Oct 23 2026: solo-budget waterfall for missing URLs
Order: (1) URL in the CSV, free; (2) Brave Search API, `"Name" "Company" site:linkedin.com/in`, $5 per 1,000 with $5 free credit a month (1,000 queries), env BRAVE_SEARCH_API_KEY, cap usage at the free credit; (3) lemlist People database while the trial lasts (ends about Nov 7 2026), env LEMLIST_API_KEY; (4) park, with a prefilled Google search link (`searchUrl`) the Owner opens on the phone. `defaultLookup = waterfall(brave, lemlist)` in import/brave.ts. A source with no key, an error or no profile passes to the next. Brave results are search-engine titles and URLs only; nothing reaches linkedin.com, and Brave's no-storage term is met because only the one approved URL is written. Same confidence rules as above.

## Update Oct 23 2026: prompt caching + real prices
Anthropic prices checked against platform.claude.com prompt-caching docs: Opus 5.5 $4/$20 (cache read $0.20, 5m write $5), Sonnet 5.5 $2/$10 ($0.10 / $2.50), Haiku 5.5 $0.10/$0.50 ($0.01 / $0.125) up to 100k-token prompts. grok-4.7 still a placeholder. One-shot tasks put the cache breakpoint on the system prompt only (never on the changing user turn); deep research also turns on automatic caching so the growing tool loop is cached. Cost booking counts cache reads and writes at their own rates; the reservation assumes a cold cache (all input at the write rate). Prefixes under 512 tokens are not cached, without error or charge.

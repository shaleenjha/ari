# CI anti-slop gate: day-one failures

Run on 2026-10-17 (IST) against the working tree, spec `docs/specs/02_ci_anti_slop_gate.md`. These are the targets for the fix pass. Do not weaken a rule or add an allow to clear one. An allow is only for a genuine false positive, and it carries a reason.

## Per job

| job / check | result |
|---|---|
| `anti-slop-static`: `lint:design:static` (copy and CSS rules) | pass, 22 files, 0 errors, 0 warnings |
| `anti-slop-static`: `lint:query` (`query-unbounded`, web + jobs programs) | pass, 35 files, 0 findings (the app reads no `.from().select()` chains yet) |
| `design-lint` Chromium 360 | 46 passed, 2 failed (48 tests) |
| `design-lint` Chromium 390 | 46 passed, 2 failed (48 tests) |
| `design-lint` Chromium 412 | 46 passed, 2 failed (48 tests) |
| `design-lint` WebKit 360/390/412 | not run locally (Playwright WebKit will not install on this linux-arm64 sandbox); runs in CI |
| `web` unit tests (vitest, includes rules and query-lint tests) | 23 passed, 0 failed (4 files) |
| `e2e` (non-design, Chromium 360/390/412) | 27 passed, 0 failed |
| typecheck web / jobs | pass / pass |

## Real failures (file:line rule)

All three Chromium widths fail the same way.

1. `src/screens/Replies.tsx:14  dead-tap`: "Draft an answer" button has no handler. Tapping it changes nothing.
2. `src/screens/Replies.tsx:14  dead-tap`: "Not now" button has no handler. Tapping it changes nothing.
3. `src/App.tsx:28  dead-tap`: the bottom tab for the screen you are on ("Replies" on Replies, "Report" on Report) links to the URL already open, so tapping it changes nothing. Fix options: scroll to top on tapping the current tab, or, if Owner agrees it is fine as is, `data-lint-allow="dead-tap current tab, tapping it again is a no-op by design"` on the active tab. That allow is a judgement call for Owner, not a gate change. (Today's tab does not trip this because `/` to `#/` is a URL change.)

Static copy rules, CSS rules, query safety, hit targets (48 px, not covered, pointer-events), contrast, rendered copy, Today height (at most 1.5 viewports at 360, 390 and 412), fonts, gradients and glows: no findings.

## Still to see in CI

WebKit has not been run. It may add findings Chromium does not show (font loading, hit targets at deviceScaleFactor 3, dead taps).

## Fix pass, 2026-10-18 (IST): Chromium gate green

All three dead taps fixed in the product. No rule weakened, no `data-lint-allow` added, harness (`e2e/mobile.spec.ts`) unchanged.

| job / check | result |
|---|---|
| `anti-slop-static`: `lint:design:static` | pass, 27 files, 0 errors |
| `anti-slop-static`: `lint:query` | pass, 40 files in 2 programs, 0 findings |
| `design-lint` Chromium 360 | 58 passed, 0 failed (58 tests) |
| `design-lint` Chromium 390 | 58 passed, 0 failed (58 tests) |
| `design-lint` Chromium 412 | 58 passed, 0 failed (58 tests) |
| `design-lint` WebKit 360/390/412 | not run locally (WebKit will not install here); runs in CI |
| `web` unit tests (vitest) | 30 passed, 0 failed (5 files) |
| `e2e` (non-design, Chromium 360/390/412) | 57 passed, 0 failed (19 per width) |
| typecheck web / jobs | pass / pass |

Design lint grew from 48 to 58 tests per width: two new walked screens in `e2e/screens.ts`, "Replies, draft open" and "Replies, Not now", so the new buttons (Copy and open LinkedIn, Hide draft, Undo, Move back to replies) and the draft text box are checked for hit targets, dead taps, contrast, copy, fonts and effects too.

### What changed

1. `src/App.tsx:28` current tab. Tapping the tab of the screen you are on (route name equals the tab, so Today's 15 and Account rooms still navigate to Today) cancels the no-op link and calls `scrollScreenToTop` (`src/ui/scrollTop.ts`). Scroll container: `scrollRoot` walks up from `main.screen` to the first element with `overflow-y` auto/scroll that overflows; none does in app2 today, so the window scrolls. Behaviour `smooth`, or `auto` (instant) when `prefers-reduced-motion: reduce` matches. Already at the top, the tap still answers: focus moves to the screen heading (`h1`, `tabindex=-1`, announced by screen readers), the spec 01 tab haptic plays (tick 4), and the tab does one 110 ms press scale to 0.955 (transform only, skipped under reduced motion). The harness sees the focus change (and the handler call).
2. `src/screens/Replies.tsx:14` "Draft an answer" opens the draft in the row: Ari's reply draft from `data().draft(personId, 'reply')` in an editable box, "Copy and open LinkedIn" (copy, then the LinkedIn inbox: Android intent, iOS universal link, web new tab; copy failure selects the text, shows "Copy failed. Text selected." and does not open) and "Hide draft". Ari never sends. Synthetic seed gained one reply draft for the fake person p-3.
3. `src/screens/Replies.tsx:14` "Not now" sets the reply aside: it leaves Replies and the Today pin, a toast "Moved to Not now." offers Undo for 10 s, then a "Not now" list on Replies keeps "Move back to replies". Session local (`src/ui/notNow.ts`).

### Open
- WebKit still unrun locally.
- "Not now" and draft edits are not saved: the data layer has no reply status or draft save command yet (`Reply.status` already has `not_now`). Wire them when the command exists.
- Spec 01 asks for a pick plus one alternative on every Ari draft; the data has one reply draft per person, so only the pick shows.
- `src/ui/styles.css` still carries the superseded Graphite values (#050505, #E2B062) that spec 01 replaces; not part of this pass.

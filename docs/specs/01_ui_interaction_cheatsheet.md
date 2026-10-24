LOCKED Oct 17 2026 by Owner. Changes need Owner's approval.
PARTLY SUPERSEDED Oct 19 2026 (approved by Owner): the palette, grid and motion sections below are replaced by
docs/specs/07_s2_visual_spec.md (S2 Lamp & Dawn, as shipped). For visuals read 07. This file still owns the interaction
contract, behaviour, Undo and the copy rules.
# 01 UI and interaction cheat sheet (app)
Supersedes plans/builder-sheet.md Graphite values (#050505/#E2B062).

## Pinned constraints
- SUPERSEDED by 07 §1 and §8 (approved by Owner Oct 19 2026): 4 px grid with 12 and 20 steps. Was: 8pt grid: sizes, gaps and padding are multiples of 8 (4 only inside a component). Gutters 16 or 24, not 20.
- Touch targets at least 48x48px, chips and icon buttons included.
- Text contrast at least 4.5:1 on its own surface. Non-text UI at least 3:1.
- SUPERSEDED by 07 §7 (approved by Owner Oct 19 2026): amber lamp accent, teal done #7CCBB8 allowed, rose friction. Was: one accent, meaning only primary action, progress, active tab. No green, gradients or glows. (No gradients or glows still holds.)

## Graphite tokens (SUPERSEDED by 07 §7, approved by Owner Oct 19 2026; kept for history, do not build from it)
| token | hex | use | contrast on bg / surface / raised |
|---|---|---|---|
| bg | #121212 | background | n/a |
| surface | #1A1A1A | cards, rows | n/a |
| raised | #242424 | sheets, toasts | n/a |
| line | #7E7E7E | borders, focus, dividers | 4.61 / 4.29 / 3.82 |
| ink | #EDEAE4 | primary text | 15.60 / 14.50 / 12.93 |
| ink2 | #A39E96 | secondary text | 7.04 / 6.54 / 5.83 |
| accent | #E5D0AC | the one accent | 12.44 / 11.56 / 10.31 |
| on-accent | #121212 | text on an accent fill | 12.44 on accent |
| danger | #F07B70 | destructive, errors | 6.93 / 6.44 / 5.75 |

Text tokens clear 4.5:1 on all three fills. Line clears 4.5:1 on bg, 3:1 everywhere. Prefer spacing over dividers. No ink3.

## Ari, the pebble
The visual mark is now the dial (07 §10). The state rules below still describe when Ari shows working or done.
One SVG component everywhere. Three states only, never random. No tricks, sleep or thought bubbles.

| state | trigger | returns to |
|---|---|---|
| calm | default, nothing in flight | stays |
| working | a real job in flight for something on screen (draft, research, scan, pull to refresh) | done on land, calm if cancelled |
| done | job landed, send marked, or queue at zero | calm after one play |

Never shows:
- working without a real in-flight job, or after it fails (calm plus the error line).
- done on an error, a loss, an Undo or a closed lost deal.
- any change while Owner is typing in a draft.
- any motion under reduced motion.

## Motion (SUPERSEDED by 07 §5 and §9, approved by Owner Oct 19 2026; the haptics and reduced-motion lines still hold)
Transform and opacity only (plus SVG `d` for Ari's face). Springs for anything touched or event driven, never linear. Mass 1 throughout.

| token | stiffness | damping | mass | use |
|---|---|---|---|---|
| press | 600 | 22 | 1 | button release |
| pop | 500 | 24 | 1 | chips, checks, switch chip flip |
| snap | 520 | 40 | 1 | exits, dismissals, no overshoot |
| bounce | 340 | 22 | 1 | tab underline, segment pill, toast in |
| soft | 200 | 26 | 1 | pane entrance, list stagger |
| sheet | 260 | 25 | 1 | sheets open |
| float | 110 | 20 | 1 | progress rings, counters (progress only) |

- Chrome settles in 320ms or less. Timed: tap 110, micro 160, quick 240. Base 360 and slow 560 are Ari and reward only.
- Easing out `cubic-bezier(.22,1,.36,1)`, exits `cubic-bezier(.4,0,1,1)`.
- Pick/alternative switch: 160ms crossfade. Stagger 42ms, cap 10. Press scale 0.955 (0.985 wide).
- Reward on send and done: Ari done plus success haptic. No confetti.

Haptics (expo-haptics / navigator.vibrate): selection, switch, tab = tick 4 · tap, copy, Undo = tap 8 · swipe threshold = 6 · send marked, stage advanced, done = success [10,40,16] · destructive, conflict line, error = warn [20,60,20].

Reduced motion (`prefers-reduced-motion`, RN `useReducedMotion`): springs become `withTiming(to,{duration:0})`, crossfades instant, loops and Ari's body stop, face kept, haptics stay.

## Behaviour
- Dry tone, short complete sentences, exact numbers. Bad news first.
- Zero fluff: no greetings, "Here you go", sign offs or filler.
- Zero gamification: no streaks, badges, points or levels.
- Ari never sends. Owner copies, opens LinkedIn and sends himself. No auto send, no LinkedIn automation.

## Core interaction contract

### Pick plus one alternative
Every Ari decision shows the pick and exactly one pre-drafted alternative. No menu, confirm dialog or regeneration wait.

States per draft: `PICK`, `ALT`, `EDITED(base=PICK|ALT)`.
| from | event | to | logged as |
|---|---|---|---|
| PICK | tap "Switch to <alt name>" | ALT | switch row (surface, from, to, actor shal) |
| ALT | tap "Back to Ari's pick" | PICK | switch row |
| PICK or ALT | hand edit saved | EDITED(base) | edit capture, not a switch |
| EDITED | tap switch | other base, edit discarded | switch row; Undo restores the edit |
| any | mark sent | locked | sent snapshot with final structure |

- One row per tap; back counts. In-flight repeats are idempotent.
- Edit = any saved text change, attributed to its base (`switched-from=<pick>` when ALT).
- Switches shape priors, never outcomes.
- Labels: "Ari's pick · S2 Confirm or correct", chip "Switch to S6 Who owns this". DM1 adds "Add a Thrandvex line". Uncleared drafts show "Flagged: <check>".

### Copy and open LinkedIn
One button: copy, then open. If copy fails, select the text, show "Copy failed. Text selected." and do not open.
- Android: `intent://www.linkedin.com/in/<slug>#Intent;scheme=https;package=com.linkedin.android;S.browser_fallback_url=<url-encoded https url>;end` via `location.href` or an anchor. Never `window.open`.
- iOS: `https://www.linkedin.com/in/<slug>` (universal link). Web: same url, new tab.
- Inbox: `/messaging/`, same rules.

### Optimistic UI, outbox, conflicts
- Writes apply locally at tap time, sent with an op id (person + action + value) so retries are idempotent.
- Offline or failed writes join the outbox, flushed on reconnect, foreground and new session. Optimistic values hold until confirmed; a stale refresh never un-ticks.
- Status only when it matters: "Saving", "Saved", "Will sync when you are back online".
- Conflict rule: once Owner types, edits or switches, any later draft is held, never applied: "New draft ready. Tap to swap." Swap has Undo for 30s. His text is re-saved if the late draft reached the server. Redraft or mark sent lifts the guard.
- Another device wins only if newer: "Changed on your other phone."

### Undo
| action | window | reverses |
|---|---|---|
| stage change, mark sent, accept, reply, meeting | toast 10s, then Activity while latest | tick, next step, queued draft |
| skip, withdraw, delete, mark personal | toast 10s, then person file | person back in every queue |
| swap to a late draft | 30s | his text |
| switch over an edit | 10s | the edit |
| Ari's automatic stage move | 48h on card, then Activity | the move; his choice sticks |

Refused only if the item moved again: "This changed since. Nothing undone."

## Copy rules
- No exclamation marks, em or en dashes, or hedging.
- No hype: seamlessly, empower, unlock, supercharge, leverage, amazing.
- No city or timezone names. Say "your hours".
- No infra words: database, server, API, worker, Supabase, Vercel, token, RLS.
- The exec lane is "the exec track". Never name the exec or the assistant.
- Buttons name the next step ("Mark DM1 sent"), never "Submit" or "OK".

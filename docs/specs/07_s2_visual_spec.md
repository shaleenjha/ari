APPROVED Oct 19 2026 by Owner. Visual source for app2, as shipped in v18.17.0 to v18.17.2 (S2). Changes need Owner's approval.
# 07 S2 visual spec: Lamp & Dawn (app2)

This records the S2 design package as it ships. It replaces the palette, grid and motion sections of
`docs/specs/01_ui_interaction_cheatsheet.md` (marked SUPERSEDED there). Spec 01 still owns the interaction contract
(pick plus one alternative, copy and open LinkedIn, optimistic UI and outbox, Undo), behaviour and the copy rules.

- **Values:** `app2/web/tokens/tokens.json` is the single source. `app2/web/src/ui/tokens.css` is generated from it
  (`scripts/tokens/gen_css.py`) and is the only place raw values live. CI (`npm run lint:slop`, `scripts/tokens/verify.py`)
  checks contrast, tokens.css == gen(tokens.json), the 4 px grid and radius set, and no raw hex in `src/`.
  If this document and tokens.json ever disagree, tokens.json wins and this document is fixed.
- **Section numbers:** sections 1 to 6 keep the S2 package's own numbering, so code comments that cite "S2 spec §3" or
  "S2 spec §5" resolve here (for example the skeleton pulse in `styles.css`: §3 Skeleton and §5 icon 9).
- **Decisions recorded (Owner, Oct 19 2026):**
  - Teal "done" #7CCBB8 is allowed. This overrides spec 01's "No green" rule.
  - Spec 01's palette, grid (8 pt, "no 20 gutters") and motion (its spring table, 320 ms chrome cap) are superseded by this spec.
  - The 4 px grid with 12 px (`--s-3`) and 20 px (`--s-5`) steps is approved.
- **Concept:** one lamp on the next send; it goes out when you're done. Graphite room, one amber lamp on exactly one
  object per view (the key, the dial index, the active tab tick, the focus ring). Dawn teal means sent and done.
  Rose means an objection. Ari prepares, the rep sends.


Base: Claude's Lamplit kit (layout, hierarchy, type, icons, dial). Colour: **Lamp & Dawn** (the package `palette/` folder). Sizes and motion: Material 3 (Compose `material3/tokens/*.kt`, androidx-main, read 18 Oct 2026). All values are CSS px at 1 dp = 1 px. Every value is a token in `app2/web/tokens/tokens.json`; `app2/web/src/ui/tokens.css` is generated from it and is all the screens and prototype read. Copy rule: counts, names, times and plain facts only. No commentary anywhere in the chrome.

## 1. Material rules applied (no Material colour, ripples, state-layer tints or shadows)

| Rule (M3 source) | Ari value |
|---|---|
| 4 dp spacing grid (Styles › Spacing) | Spacing scale `--s-1…--s-12` = 4, 8, 12, 16, 20, 24, 32, 48. Only borders and strokes may be 1 to 2 px |
| Compact window margin 16 | `--margin: 16px` |
| Touch target 48 × 48 | Every control. A 40 px button gets a 48 hit box from `::before` |
| Button M 56: padding 24, icon 20, gap 8; square corner 16 → pressed 12 (ButtonMedium tokens) | The key: 56 high, padding 24, 20 icon, gap 8, r16 → r12 plus scale 0.96 on press |
| Button S 40: padding 16; corner 12 → pressed 8 | Mark sent in rows, Skip, Undo, Withdraw/Archive |
| List items 56 / 72 / 88 (ListTokens) | Module rows 56, Today's 15 and Tidy up rows 88. Up next stays **64** (Claude's compact two-line row, a deliberate departure from 72) |
| Navigation bar 64, icon 24, label 12/16, gap 4 (NavigationBarTokens) | 64 + safe area. No pill indicator: active = text-1 label + amber 16×2 tick + amber dial index |
| Bottom sheet: max width 640, top margin 72, handle 32 × 4, top corners 28 (SheetBottomTokens) | Same values. Handle sits in a 48 zone. Scrim is canvas at 50% |
| Motion: springs (StandardMotionTokens; Expressive for one effect) | See section 5 |

## 2. Layout (390 × 844 installed iPhone; 360 × 780 Android)

Fixed stack above the draft well: safe top + status 24 + header 48 + card top margin 12 + border 1 + padding 16 + chip 32 + 12 + name 26 + meta 18 + 12 = **safe + 201**; the key centre is then safe + 201 + well + 16 + 28. The well takes the rest, so the key centre lands at 54 to 56% of the visible height:

```css
.well { height: clamp(calc(var(--lh-body) * 3 + 24px),
                      calc(55svh - env(safe-area-inset-top) - 245px),
                      calc(var(--lh-body) * 6 + 24px)); }
```

Text clamps to whole lines. Measured key centre: **54.5%** at 390 × 844 and 360 × 780. `svh`, not `dvh`, so it never resizes mid-scroll.

## 3. Components

**Status line** (24, `--fs-status` 12/16 500, text-3, tabular). Left: "Sun 18 Oct". Right: a 6 px teal sync dot, gap 8, then "ET 12:22 PM · window open". The clock updates each minute and has no seconds. Offline: the cloud-slash icon at 16 replaces the dot, the text is text-2, "Offline · loaded 6:15 PM".

**Header** (48). Left: counts in body 15/22. "7 of 34" is 560 weight in text-1, then "·" in text-3, then "9 ready" at 400 in text-2. Right: a 28 dial with a 24 viewBox, track r9 in surface-3, arc in text-1 at 1.5 stroke, and the amber index (r1.75) riding the arc end.

**Hero card** (one per view). Surface-1, 1 px hairline (friction on an objection), r20, padding 16 / 16 / 8.
- Chip: 32 high, padding 8 / 12, gap 8, surface-2, hairline, r8. Signal icon 16 in amber, fact in meta 13/18 460, then "· 2d" in text-3. At most 60 characters.
- Name: 20/26 600, −0.008em, one line with ellipsis. Meta "VP Engineering · Pyrrhovane Health" in 13/18 text-2.
- Draft well: canvas, r8, padding 12, body 15/22, 3 to 6 lines. No "Ari draft" label.
- **Key:** amber #F0AA3C, ink #121212 (9.38:1), 56 high, r16, label 16/20 560 with a 20 icon. "Copy and open LinkedIn" pairs with copy. After returning from LinkedIn (`visibilitychange`) the same key reads "Mark sent" with send. The label box is `position:absolute; inset:0` so a label swap is never a layout shift (measured CLS 0). Pressed: scale 0.96, r12, #D9962F, 100 ms.
- Skip for now: text button with a 48 target, body 560 in text-2, 4 above.

**Up next**. A caps eyebrow "UP NEXT · 8" in 11/16 600, +0.08em, text-3, 24 below the card. Rows are 64: name in body 560, meta below, and on the right the 16 signal icon plus age in tabular text-3. Hairline dividers sit between rows.

**Module rows** (scrolled Today). 56 rows: a 20 icon in text-2, then "Today's 15 · 6 of 15 sent" or "Tidy up · 20 to check", then a 20 chevron in text-3. A row opens a sheet.

**Sheets**. Surface-2, top r28, max-height `100% − 72 − safe-top`, padding 0 16 and safe + 16 at the bottom. Handle 32 × 4 in text-3 inside a 48 zone. Title row: 22/28 600 on the left, a tabular count in meta on the right. Today's 15 adds one meta line, "Max 3 per account".
- Today's 15 row (88): name, role · company, "2 of 3 at Bravossine" in text-3; outlined S button "Mark sent" (40, padding 16, r12, border #716D65). Sent: teal check + "Sent", name to text-2; tap again to revert.
- Tidy up row (88): name, role · company, and a status line with a 16 icon ("Invite pending 24d" with waiting, "No reply 9d after DM2" with on-hold). Action: Withdraw or Archive. **Only the first row is filled amber.** The rest are outlined.

**Replies**. The newest unsorted reply is the hero: friction caps line with icon ("OBJECTION · HAS A VAULT VENDOR"), name 20/26 with age right, meta, the quoted reply in the well, one plain fact with the signal icon, then a 2 × 2 grid of outlined M keys (56, r16, gap 8). The suggested key carries a 6 px amber dot; the rep confirms. "Then · 2" rows follow at 64.

**Report**. Title "This week · 13 to 17 Oct" in 22/28. A `<dl>` grid of 2 columns with gap 8. Tiles are surface-1, r16, padding 16, min 112. Each tile has:
- an eyebrow "01 CONNECTS" (the number in text-3)
- a metric 28/32 520 tabular
- a delta row: 16 caret + "8 vs last week" in text-3

A full-width tile 05 closes it; Sign out is a 48 text button.

**All Clear**. The hero keeps its height: a 120 teal ring (2 px) and check (3 px), "34 sent" 22/28, "Next scan 4:30 PM" in meta. Header dial closed and teal. Nothing else.

**Empty**. A 64 mark (ring in text-3, amber index), then one meta line: "Nothing to sort. Next check 10:30 PM".

**Skeleton**. Identical geometry, so CLS is 0. Every line keeps its full line box and draws a surface-3 bar inside it (8 px in a 22 line, 16 in a 26 line). Bars pulse opacity 0.5 → 0.8 over 1.6 s, alternating, only while loading (8 s max), then hold at 0.65.

**Toast**. 48 high, 16 above the nav, surface-2, hairline, r12, padding 0 4 0 16. "Marked sent" plus an amber text button "Undo". Hides after 5 s.

**Nav**. 64 + safe area, surface-1, hairline top. Three equal tabs, each with a 24 icon, gap 4 and a 12/16 500 label. Inactive: text-3 with a grey index dot. Active: text-1 label, the dial index turns amber, and a 16 × 2 amber tick sits on the top edge. "Replies 3" shows the count as plain tabular digits.

## 4. Icons

24 × 24 grid with a 2 px safe margin, 1.5 px stroke, round caps and joins, `currentColor`. The check is the only 2 px stroke. The only fill is the amber index dot (`var(--accent)`). Sizes: 16 for chips and states, 20 inside keys and rows, 24 in the nav.

The set has 19 icons: signal, copy, open-link, send, check, done, ready, waiting, on-hold, friction, tidy-up, offline, refresh, chevron-right, delta-up, delta-down, nav-today, nav-replies, nav-report. Files: `app2/web/src/ui/icons/sprite.svg` (`<use href="#ari-copy"/>`), sources in the package `icons/map.json` (Phosphor Regular geometry, MIT, redrawn as strokes, plus custom glyphs). Every state glyph ships with its word.

## 5. Motion

Springs are the M3 Compose tokens (mass 1), sampled to CSS `linear()` until they settle within 0.1% (package `_build/springs.py`):

| Token | ζ / stiffness | Settles | Overshoot | Use |
|---|---|---|---|---|
| `spatial-fast` | 0.9 / 1400 | 220 ms | 0.15% | press release, chevron, tab tick |
| `spatial-default` | 0.9 / 700 | 320 ms | 0.15% | arrivals, counters, dial, toast, draws |
| `spatial-slow` | 0.9 / 300 | 480 ms | 0.15% | sheets, refresh turn, All Clear ring |
| `effects-fast` | 1.0 / 3800 | 150 ms | 0 | icon fades |
| `effects-default` | 1.0 / 1600 | 230 ms | 0 | colour changes |
| `expressive-fast` | 0.6 / 800 | 360 ms | 9.5% | **the check pop and the friction nudge only** |

Fallbacks where `linear()` is missing: M3 emphasized-decelerate `(.05,.7,.1,1)` for spatial springs and standard `(.2,0,0,1)` for effects. Exits use emphasized-accelerate `(.3,0,.8,.15)`.

**Rules.** One moving thing at a time. Nothing loops while idle. Only `transform`, `opacity`, `stroke-dashoffset` and colour are animated: no layout properties, no JS animation libraries. JS only swaps classes and calls `navigator.vibrate`. Under reduced motion every animation runs in 1 ms (it lands in its end state), the contents crossfade over 100 ms, and haptics stay on.

### Icon motion

| # | Icon / trigger | Keyframes | Duration · curve | Reduced motion |
|---|---|---|---|---|
| 1 | Tab select | ring dashoffset 0.35 → 0, then index dot scale 0 → 1 and grey → amber | 320 spatial-default; dot 360 expressive-fast, +100 | dot amber, no draw |
| 2 | Copy → check (key, on copy) | copy rects opacity 1 → 0, scale 1 → 0.7; check dashoffset 1 → 0 | 150 effects-fast; check 320 spatial-default, +100 | check shown |
| 3 | Send launch (Mark sent) | plane translate(8, −8) scale 0.8, opacity → 0 | 320 emphasized-accelerate | instant |
| 4 | Dial index sweep (each send) | arc dashoffset −1/34; index rotate +10.6° | 320 spatial-default | jump |
| 5 | Refresh (pull or tap, once) | rotate −360° → 0 | 480 spatial-slow, never loops | none |
| 6 | Offline (on going offline) | cloud opacity 1 → 0.6; slash dashoffset 1 → 0 | 230 effects-default; slash 320, +50 | end state |
| 7 | Friction nudge (objection card arrives) | translateX −4 → 0 | 360 expressive-fast | none |
| 8 | Chevron (row press → sheet open) | translateX 4 on press; rotate −90° on open | 220 spatial-fast | none |
| 9 | Skeleton | opacity 0.5 ↔ 0.8, alternate, 5 cycles max | 1.6 s linear, only while loading | static 0.65 |
| 10 | Done check | ring scale 0.85 → 1; tick dashoffset 1 → 0 | 360 expressive-fast / 320 spatial-default | end state |
| 11 | Ready dot (card becomes ready) | scale 0 → 1 | 220 spatial-fast | shown |
| 12 | Waiting hand | rotate −60° → 0 | 320 spatial-default | shown |
| 13 | Sync dot (while a sync runs) | halo scale 1 → 3, opacity 0.6 → 0, 3 rings max | 2 s emphasized-decelerate | static dot |
| 14 | First screen (once per session) | 4 items rise 8 px → 0, 30 ms apart | 220 emphasized-decelerate | none |
| 15 | Tile or row press | scale 0.98 | 100 linear | none |

Cost: compositor properties or one SVG stroke per element. Headless Chromium p95 frame 16.8 ms over three sends; a mid Android device check is still due.

### Mark sent timeline (t = 0 at release)

| t (ms) | Element | Change | Curve |
|---|---|---|---|
| −100 | Key | scale 0.96, r16 → r12, amber → #D9962F | 100 linear |
| 0 | Haptic | `vibrate([10, 50, 16])`; iPhone one tick | |
| 0 | Send glyph | launches (icon 3) | emphasized-accelerate 320 |
| 120 | Key | teal fill fades in over the amber; label out; check pops (scale 0.4 → 1, draw) | effects-fast 150; expressive-fast 360 |
| 200 | Header | count rolls up one line ("8"); dial index sweeps (icon 4) | spatial-default 320 |
| 520 | Card contents | translateX −(100% + 32) and opacity 0, over 320 | emphasized-accelerate |
| 520 | Toast | rises 16 → 0: "Marked sent · Undo" | spatial-default |
| 640 | Next contents | translateX 24 → 0, opacity 0 → 1; key back to amber "Copy and open LinkedIn" | spatial-default 320 |
| 960 | | next card settled, key ready | |
| 5,520 | Toast | out | effects-fast |

Undo reverses it (contents exit right, previous card returns from the left, count and dial roll back, `vibrate(8)`).

**All Clear** fires once per day, on the send that empties the queue:
640 key and Skip fade; 790 the ring closes its last 3% (600 ms, spatial-slow); 1,400 ring turns teal, check pops, `vibrate([12, 60, 12, 60, 24])`, header dial closes; 1,560 "34 sent" and the scan time rise 8 px.

Reopening that day shows the end state, still.

## 6. Departures from Claude's kit

- **Colour:**
  - The key changes from bone #ECE6DB to amber #F0AA3C. The brand colour lives on the one key.
  - Brass #D8B572 → amber, Moss #A5CB86 → dawn teal #7CCBB8, Ember #E8735A → rose #F0758F.
  - Canvas #141311 → #121212, and the surfaces are retuned.
- **Copy:**
  - The status sentence becomes counts.
  - The "ARI DRAFT" label is removed.
  - "Synced 7:52 PM" becomes an ET clock, window state and the sync dot.
  - The All Clear quip and the empty-state sentence become plain facts.
- **M3 sizes:**
  - nav 56 → 64, labels 11 → 12
  - key r14 → r16 with the pressed morph to r12
  - chip 28 → 32
  - Today's 15 row 82 → 88, and its Mark sent key 112 × 48 → an S button
  - sheet r24 → r28
  - toast 56 → 48 with r12
  - caps line height 14 → 16 (4 grid)
- **Motion:** M3 spring tokens replace Claude's springs; overshoot 12.6% → 9.5%, check and friction nudge only.
- **Icons:** all strokes on 24 (was mixed filled Phosphor at 256 and stroked custom); copy and refresh added.
- **Report:** tiles are numbered 01 to 05.

## 7. Palette (Lamp & Dawn, exact values from tokens.json)

Surface: Graphite canvas #121212. Accent: amber #F0AA3C. Done: dawn teal #7CCBB8. Friction: rose #F0758F.
Luminance is elevation, hue is meaning: surfaces only get lighter as they come forward.

| Token | Hex | Role |
|---|---|---|
| `--canvas` | #121212 | App background. Locked graphite, unchanged |
| `--surface-1` | #1C1B19 | Hero card, nav, Report tiles |
| `--surface-2` | #252421 | Sheets, snackbar |
| `--surface-3` | #2E2C29 | Chips, skeleton bars. Never carries text-3 or a control edge |
| `--hairline` | #34322E | Decorative dividers only |
| `--border` | #716D65 | Outlined controls. 3:1+ on canvas, surface-1, surface-2 |
| `--text-1` | #ECE6DC |  |
| `--text-2` | #B5AFA4 |  |
| `--text-3` | #979289 | Never on surface-3 |
| `--accent` | #F0AA3C | Ari Lamp amber. The brand: key fill, dial index, active tab, focus, app icon index |
| `--accent-pressed` | #D9962F |  |
| `--on-accent` | #121212 | Ink on the amber key |
| `--friction` | #F0758F | Objection. Always glyph + word |
| `--done` | #7CCBB8 | Dawn teal. Sent, done, the closed dial |
| `--focus` | #F0AA3C |  |
| `--scrim` | #121212 | Sheet backdrop at 50% opacity |

Contrast (CI computes every pair): all text tokens clear 4.5:1 on every surface they may touch; text-3 is barred from
surface-3 by rule; `--border` clears 3:1 wherever an operable edge is allowed; ink #121212 on the amber key is 9.38:1.
Rose stays clear of amber for every colour-vision type (ΔE₀₀ ≥ 10.7). Every state is glyph + word + colour.

## 8. Type, spacing, sizes and radii

Face: **Instrument Sans** (variable 400 to 700, Latin, OFL, self-hosted) with metric-matched Arial and Roboto fallbacks, tabular
figures for every count and time. Sizes follow the Material 3 type scale adapted to Ari's roles. Note: the S2 brief named
Inter; the package chose Instrument Sans instead (Inter is the default SaaS face and its subset is larger), and that is what ships.
Sizes are rem on `--u: 1rem`.

| Role | Size | Line height | Weight | Tracking |
|---|---|---|---|---|
| title | 1.375rem | 1.75rem | 600 | -0.012em |
| name | 1.25rem | 1.625rem | 600 | -0.008em |
| body | 0.9375rem | 1.375rem | 400 | 0em |
| body-strong | 0.9375rem | 1.375rem | 560 | 0em |
| meta | 0.8125rem | 1.125rem | 460 | 0.005em |
| caps | 0.6875rem | 1rem | 600 | 0.08em |
| button | 1rem | 1.25rem | 560 | 0.005em |
| metric | 1.75rem | 2rem | 520 | -0.01em |
| status | 0.75rem | 1rem | 500 | 0.01em |
| label | 0.75rem | 1rem | 500 | 0.01em |

- **Spacing (4 px grid):** `--s-1` 4px, `--s-2` 8px, `--s-3` 12px, `--s-4` 16px, `--s-5` 20px, `--s-6` 24px, `--s-8` 32px, `--s-12` 48px, `--margin` 16px. Only borders and strokes may be 1 to 2 px.
- **Sizes:** touch target 48, key (button M) 56, button S 40, chip 32, rows 56 / 64 / 88, nav 64, header 48, status 24,
  snackbar 48, sheet top margin 72 and max width 640, handle 32 x 4, icons 16 / 20 / 24, dial 28, stroke 1.5, draft well 3 to 6 lines.
- **Radii:** `chip` 8px, `well` 8px, `btn-s` 12px, `btn-s-pressed` 8px, `btn-m` 16px, `btn-m-pressed` 12px, `tile` 16px, `card` 20px, `sheet` 28px, `snackbar` 12px, `full` 9999px.

## 9. Motion tokens (M3)

Springs are the M3 Compose StandardMotionTokens (Expressive for one effect), mass 1, sampled to CSS `linear()`:

| Token | Damping ratio | Stiffness | Settles | Overshoot | M3 source |
|---|---|---|---|---|---|
| `spatial-fast` | 0.9 | 1400 | 220ms | 0.15% | StandardMotionTokens.SpringFastSpatial |
| `spatial-default` | 0.9 | 700 | 320ms | 0.15% | StandardMotionTokens.SpringDefaultSpatial |
| `spatial-slow` | 0.9 | 300 | 480ms | 0.15% | StandardMotionTokens.SpringSlowSpatial |
| `effects-fast` | 1.0 | 3800 | 150ms | 0.0% | StandardMotionTokens.SpringFastEffects |
| `effects-default` | 1.0 | 1600 | 230ms | 0.0% | StandardMotionTokens.SpringDefaultEffects |
| `effects-slow` | 1.0 | 800 | 330ms | 0.0% | StandardMotionTokens.SpringSlowEffects |
| `expressive-fast` | 0.6 | 800 | 360ms | 9.48% | ExpressiveMotionTokens.SpringFastSpatial |

Fallback easings where `linear()` is unsupported:

| Easing | Value |
|---|---|
| standard | cubic-bezier(0.2, 0, 0, 1) |
| emphasized-decelerate | cubic-bezier(0.05, 0.7, 0.1, 1) |
| emphasized-accelerate | cubic-bezier(0.3, 0, 0.8, 0.15) |
| standard-decelerate | cubic-bezier(0, 0, 0, 1) |
| standard-accelerate | cubic-bezier(0.3, 0, 1, 1) |

Durations: short1 50ms, short2 100ms, short3 150ms, short4 200ms, medium1 250ms, medium2 300ms, medium3 350ms, medium4 400ms, long1 450ms, long2 500ms, long3 550ms, long4 600ms. Reduced motion: every animation lands in its end state in 1 ms, contents crossfade over 100 ms, haptics stay.

## 10. Ari's mark (the dial)

A ring one step from closed, with the amber index sitting in the gap. It is the day's progress, not a character.
- Header and nav: 28 dial on a 24 viewBox, track r9 in surface-3, arc in text-1 at 1.5 stroke, amber index (r1.75) riding the arc end.
  Each send sweeps the index (§5 icon 4).
- All Clear: the ring closes and turns teal, the check pops (§5 All Clear). Empty state: a 64 mark, ring in text-3, amber index.
- App icon (180 master): canvas #121212, arc stroke #ECE6DC at 9.84 with round caps, amber #F0AA3C index dot r8.51.
  Files: `app2/web/public/brand/`.
- No face, mascot, quips, streaks or confetti. This replaces spec 01's pebble as the visual mark.

## Sources
- S2 design package (private workspace, `work/s2-package/ari-s2-design/`: `spec.md`, `brand/BRAND.md`, `README.md`), Oct 18 2026.
- `app2/web/tokens/tokens.json` and `app2/web/src/ui/styles.css` at v18.17.2.
- S2 design review 01 finding S2-1 (Oct 19 2026), which asked for this file.

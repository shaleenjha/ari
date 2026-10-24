# Ari 2 B+ shell (locked by Owner, Oct 24 2026 12:22 IST)

## What it is
The front end Owner locked as "B+": two places, **Stack** (home) and **Desk**, switched by the bottom pill "Stack | Desk" or a sideways swipe. Sheets from the header (Accounts, Report), a Motion detail screen, the Account page from the avatar, and a one-button Sign-in. Demo data only (synthetic people and companies in `web/src/b/demo.ts`).

It lives at **`/b.html`** (entry `web/b.html`, code in `web/src/b/`), beside the current app at `/`, until a cutover slot moves it to `/` and retires the old screens and their tests. Nothing in `/`, `src/data/auth.ts` or the live Google sign-in changed; web/ops.html is untouched.

## Tokens: B+ supersedes S2 for app2
Owner's lock wins over the older S2 package: the B+ palette and **Plus Jakarta Sans** replace Lamp & Dawn and Instrument Sans for app2. `docs/specs/07_s2_visual_spec.md` and `work/s2-package` stay as history for the screens at `/` until the cutover.

- Source: `web/tokens/bplus.json`. Generated CSS: `web/src/b/tokens.css` (`npm run tokens:b`). `npm run lint:tokens` runs `scripts/tokens/gen_bplus.py --check`: file fresh, every text pair 4.5:1 or better in light and dark, boundaries 3:1, no green in the palette.
- Light: paper #F7F6EF, card #FFFFFF, well #EFEDE3, ink #1B1B2E, nightPass #2A2946, lavender #C2C1EB (ready, accepted), salmon #F7866D (needs you), dawn #FAF79B (due today), mist #B9B8DC (quiet text on dark).
- Dark: bg #121220, cards #2A2946, text paper, same chips. On from 18:00 to 06:00 local and whenever the system is dark (`src/b/theme.ts`; `?theme=light|dark` pins it for QA).
- Added by the builder, flagged for Owner: **inkSoft #4D4C6B** (quiet text on light grounds, 7.6:1 on paper), **nightWell #1F1E36** (draft box inside a pass), and two decorative divider lines (paperLine #DAD8CC, nightLine #3D3C5E). The lock named no quiet light text colour.
- Icons: Tabler outline (MIT), sprite `web/src/b/icons/tabler.svg` built by `scripts/icons/build_tabler.py`, inlined into b.html by vite.config.ts. Font: `web/public/fonts/plus-jakarta-sans-latin-wght.woff2` (OFL, licence beside it).
- No gradients or glows, touch targets 48px, motion under 300 ms except the done moment (720 ms), all durations 1 ms under reduced motion.

## Routes (every state has a URL)
`#/stack`, `#/stack?pass=reply|dm2|dm1|connect|exec|waiting`, `#/desk`, `#/stack?sheet=accounts|report` (or on `#/desk`), `#/motion/<id>`, `#/account`, `#/signin`.

## Files
`App.tsx` (shell, pill, swipe, header, toast), `store.ts` (pure reducer), `demo.ts` (fixtures), `route.ts`, `theme.ts`, `tasks.ts` (Ask Ari split), `notify.ts`, `ui.tsx` (icon, chip, avatar, sheet, switch, stepper, toast), `screens/*`, `b.css`, `screens.css`. Tests: `src/b/b.test.ts` (unit), `e2e/bplus.spec.ts` (behaviour, plus `@design` tap size, contrast, copy and no-green checks in light and dark).

## Screenshots
`node scripts/bplus/shots.mjs` (needs a running preview, `BASE=`) then `python3 scripts/bplus/montage.py`. Output in `work/app2-shell-shots/` (not committed).

## Lint changes
`scripts/design-lint`: `B_TOKENS_FILE` (src/b/tokens.css) may hold raw colours like the S2 token file; b.html copy is linted. `scripts/tokens/verify.py` skips src/b/tokens.css for raw hex (gen_bplus.py checks it). `public/sw.js` leaves `/b.html` to the network so it never replaces the cached `/` shell.

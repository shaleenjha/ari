# app code step (two-step sign-in): spec for Tony

**Goal:** once Owner has an authenticator enrolled, app asks for the 6-digit code after Google sign-in. Until the code is accepted, it shows **no** data, cached or fresh. Without a factor (today), nothing changes.

**Scope:**
- Sign-in only.
- Enrolment, removal and recovery stay where they are:
  - ops.html already enrols, verifies and removes factors (`auth.mfa.enroll`, `challengeAndVerify`, `unenroll`);
  - RESTORE.md covers a lost authenticator (a maintenance session deletes the factor).
- app gets its own enrolment screen when Settings exists (Diamond or later).

**Server side:**
- Release 5 (0037) makes every member and owner policy require `aal2` once a verified factor exists.
- An `aal1` session of an enrolled user therefore reads **zero rows**. The app must not show that as an empty Today ("nothing to do"). Hence the guards below.

## 1. When to ask

app has no supabase-js; it talks to `/auth/v1` with `fetch` (`src/data/auth.ts`). It decides from the session, never from empty data:

| current level: `aal` claim of the access token (missing = `aal1`) | next level | what app does |
|---|---|---|
| `aal1` | `aal1` (no verified factor) | the app, as today |
| `aal1` | `aal2` (a verified TOTP factor exists) | **code step**; no reads, no cached Today |
| `aal2` | `aal2` | the app |

- **Next level:** `GET /auth/v1/user` (headers `apikey`, `Authorization: Bearer <access token>`). It's `aal2` if any `factors[]` entry has `factor_type: "totp"` and `status: "verified"`.
- **When to check:**
  - after the Google `id_token` exchange;
  - on a warm boot whose stored token is `aal1`;
  - after a refresh that comes back `aal1`.
- Store the result with the session (`nextLevel: 'aal1' | 'aal2'`, plus when it was checked).
- **Offline warm boot:**
  - An `aal2` token needs no network: proceed.
  - An `aal1` token proceeds offline only if the stored `nextLevel` is `aal1`.
  - Otherwise show "Connect to the internet to finish signing in" and nothing else.

## 2. The flow (REST)

1. `GET /auth/v1/user`: pick the verified TOTP factor (the newest, if there are several).
2. `POST /auth/v1/factors/{factorId}/challenge`
   - Headers: `apikey`, `Authorization: Bearer <aal1 access token>`. Body: `{}`.
   - Returns `{ id, type, expires_at }`. Keep `id` as the challenge id.
3. Owner types the code.
4. `POST /auth/v1/factors/{factorId}/verify`
   - Same headers. Body: `{ "challenge_id": "<id>", "code": "123456" }`.
   - Returns the same token shape as the `id_token` exchange: `access_token` (now `aal2`), `refresh_token`, `expires_in` / `expires_at`, `user`.
5. Save it through the existing `toSession` / `save()`: it replaces the `aal1` session, and other tabs pick it up through the existing storage-event path.
6. Then mount the app. Refreshes keep the session's level. After a factor is removed, the level drops at the next refresh, so re-check whenever a refresh returns `aal1`.

Lint: these are POSTs to `/auth/v1/`, which `scripts/query-lint/no-client-writes.mjs:40` already allows. Write the URLs in place, as the sign-in call does, so the rule still sees them.

## 3. Errors (Supabase Auth `error_code` → what Owner sees)

| code | meaning | app |
|---|---|---|
| `mfa_verification_failed` | wrong code | "That code didn't match. Try the newest one." Clear the field, get a fresh challenge before the next try. |
| `mfa_challenge_expired` | took too long | Get a fresh challenge silently, keep the screen, ask again. |
| `over_request_rate_limit` (429) | too many tries | "Too many tries. Wait a minute, then try again." Disable Verify for 60 s. |
| `mfa_factor_not_found` | factor removed meanwhile | Re-check `/auth/v1/user`. If there's no factor, continue at `aal1`. |
| `insufficient_aal` (from an Auth call) | the session is below `aal2` | Treat as "code needed": show the code step. Database reads don't raise this; under row rules they just return nothing, which is why the guards in section 5 exist. |
| network or 5xx | can't reach the server | "Can't reach Ari right now." Keep the code and retry. |
| refresh terminal (existing `isTerminal`) | session gone | Purge, exactly as today. |

## 4. Screen (S2 tokens and copy rules)

- One screen with no tabs or nav.
  - Title: "Enter your code".
  - Line: "Open your authenticator app and type the 6-digit code for Ari."
- **One text field, not six boxes:** `inputmode="numeric"`, `autocomplete="one-time-code"`, `pattern="[0-9]*"`, `maxlength="6"`.
  - Visible label, 48 px target.
  - Strip spaces on paste.
  - Submit on the 6th digit.
- **Buttons:**
  - "Verify": the one filled key, 56 px, disabled while a request is in flight.
  - "Sign out": a text button that runs the existing `signOut()` (purges everything).
- Errors in `role="alert"`. Respect reduced motion. No "MFA", "TOTP" or "AAL" in the copy.

## 5. Guards (defence in depth)

- **Data layer:** while the level is `aal1` and the next level is `aal2`, every `data()` read throws `CodeNeeded`. The shell shows the code step. Nothing reaches `/rest/v1`.
- **Device copy:** `seedFromDevice()` and `wireToday()` do nothing until the session is `aal2` (or the next level is `aal1`). The IndexedDB Today was written by an `aal2` session and must not appear before the code.
- **The code itself:** never stored, logged, put in a URL or kept after the request.
- **Cross-tab:** when the session changes in another tab, re-evaluate the level before rendering.

## 6. Tests

- **Unit:** the level table above, including a missing `aal` claim (treated as `aal1`) and the offline rule.
- **e2e, auth endpoints mocked:**
  1. Sign in, user has a verified factor → the code screen shows and **no `/rest/v1` request** is made before verify (assert on the request log).
  2. Wrong code → error text and a new challenge.
  3. Expired challenge → a new challenge with no error shown.
  4. 429 → Verify is disabled for 60 s.
  5. Right code → Today renders.
  6. Reload → no code step (an `aal2` session is stored).
  7. Sign out from the code screen → session and device copy are gone.
  8. A stored `aal1` session with a factor plus a seeded IndexedDB Today → Today does **not** render.
- **Design lint:** add the code screen to `e2e/screens.ts` (targets, contrast, dead taps, copy).
- **SQL:** `checks_after_0037.sql` (release 5) already proves the server side: `aal1` with a factor reads 0 rows and can't write.

## 7. Turning it on (Owner)

1. Release 5 and this step are on main and CI is green (SQL test, e2e, design lint on Chromium and WebKit).
2. Owner enrols in ops.html (RESTORE.md §4), signs in to both apps on iPhone and Android, enters the code, reloads, and signs out and back in.
3. RESTORE.md's lockout path stays: a maintenance session deletes the factor, then he re-enrols.

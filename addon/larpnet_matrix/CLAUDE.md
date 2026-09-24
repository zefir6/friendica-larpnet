# CLAUDE.md

Guidance for this addon specifically. See the repo root `CLAUDE.md` for the
overall project.

## What this addon is

A login bridge to a self-hosted Matrix/Synapse homeserver, AND the
same-origin host for larpnet's own minimal Matrix web client
(`client/`) -- see `larpnet_matrix.php`'s own docblock for the request-level
behavior (routes, JWT contract, profile sync).

**This replaced an earlier design** that redirected into a separately
hosted `vectorim/element-web` container (on its own `chat.<domain>`
subdomain), via a small SSO bridge page. That design was abandoned after
live testing surfaced a reliably reproducible "Unable to restore session"
crypto-store corruption bug. The **confirmed** root cause: the old bridge
page's `?jwt=` handoff skipped a real login and hand-seeded a previous
session's tokens into `localStorage` whenever one already existed, leaving
Element's crypto engine to cold-boot-restore a session it never itself
logged into. This client (`client/src/matrix.js`) never does that -- every
boot does one real, fresh JWT login (persisting only a stable, non-secret
`device_id`), so the only code path ever exercised is the well-tested
login -> initRustCrypto -> startClient sequence, never a shortcut around it.
That fix alone is embedding-independent (iframe or popup window, it holds
either way) -- see `js/matrix-chat-widget.js`'s own docblock for a second,
separately-suspected-but-never-fully-confirmed failure mode (destroying and
recreating the iframe across Friendica page navigations racing IndexedDB
teardown) and the current mitigation for it. The widget went iframe ->
popup window -> back to iframe over the course of this addon's development
-- if session-restore corruption ever recurs, re-read that docblock before
re-deriving the history from scratch.

## Why there's no device-verification UI

The client (`client/src/matrix.js`) initializes rust-crypto and starts the
client, but never bootstraps cross-signing or secret storage, and never
shows Element-style "Verify this device" prompts. This is deliberate, not
an oversight:

- A single device can encrypt and decrypt messages in a room it's a member
  of without ever setting up cross-signing. Cross-signing/verification only
  establishes *trust between multiple devices* -- irrelevant to this
  client's actual usage pattern (one browser, one device), so there's no UI
  to build for it in v1.
- **Do not "fix" the lack of a verification prompt by having this addon
  mint or derive a secret-storage/recovery key itself** (e.g. from the same
  JWT secret used for login). That was tried in the old Element-embedding
  design (a `larpnet_matrix_recovery_key()` function, since removed) and is
  a bad idea independent of whether it works: if the operator can compute a
  user's secret-storage recovery key, the operator can decrypt that user's
  backed-up message history, which defeats E2EE's confidentiality guarantee
  against us specifically (it still protects against network eavesdroppers
  and outside parties, but not against us). If secure backup is ever wanted
  here, it must use a key generated client-side and shown to the user once,
  never known by the server.

## Matrix displayname sync -- why it matters for names shown to *other* users

Matrix's own displayname for an account is only ever set by that account
setting it on itself. `larpnet_matrix_sync_profile()` pushes the
currently-authenticated user's own larpnet name to their own Matrix profile
on each throttled page load -- but that only ever covers the *viewer*.
Anyone who's never opened chat has no Matrix displayname at all, so they'd
show up to *everyone else* as a raw `@localpart:server` mxid -- in the room
list, and in any group room they're a member of (matrix-js-sdk's own
multi-member room-name summary reads each member's real Matrix
displayname, so this isn't just a room-list cosmetic issue).

Three layers close this gap, each covering what the one before it misses:
1. `client/src/matrix.js`'s `resolveDisplayName()` -- client-side, maps a
   mxid back to a Friendica name via `config.contacts` (same list the
   picker uses). Instant, but only covers 1:1 DMs with a *published*
   profile, and doesn't fix group-room naming (that comes from Matrix's
   own summary, not this client's rendering).
2. `larpnet_matrix_content()` syncing the active `?dm=` target's own
   Matrix profile, not just the viewer's. Fixes it at the source (once
   synced, *everyone* sees that person's real name, including in group
   rooms), but only for users someone has actually opened a DM with via
   that route (not e.g. someone only ever reached through the picker).
3. `larpnet_matrix_cron()` (registered on the `cron` hook) -- eventually
   syncs every local user, closing the remaining gap (picker-only
   contacts, group members never DMed directly). **Only fires on a
   deployment with an active worker daemon.** The test stack deliberately
   has none (see root `CLAUDE.md`'s "Test/staging environment" isolation
   design) -- this is inert there by construction, not a bug, and can't be
   live-verified on `test.larpnet.pl` for that reason. Verify it (if ever
   in doubt) on a deployment that actually runs a worker, or by invoking
   `larpnet_matrix_cron()` manually.

**All three of the above were completely inert for a long time before
anyone noticed**, because of one thing none of them had anything to do
with: `larpnet_matrix_sync_profile()`'s server-side calls to Synapse (via
`LARPNET_MATRIX_INTERNAL_URL`) were being silently blocked by Friendica's
own SSRF protection the whole time (`system.block_private_addresses`,
default `true` -- `src/Util/Network.php`'s `isPrivateTarget()`, checked by
every `DI::httpClient()` call). An internal Docker-network address is by
definition non-public, so every single sync attempt failed before ever
reaching Synapse -- and failed *silently*, because the failing calls' own
results were never checked either (see the "stop silently swallowing"
fix), so there was nothing to notice. Two separate, compounding bugs, both
now fixed: `larpnet_matrix_allow_internal_host()` (called from
`larpnet_matrix_settings()`, so it self-heals on any redeploy without
needing the addon disabled/re-enabled) adds
`LARPNET_MATRIX_INTERNAL_URL`'s own host to Friendica's documented escape
hatch, `system.allowed_internal_hosts`, rather than disabling the
protection wholesale.

**A third, separate bug was still masked underneath that one**: every
`DI::httpClient()->request()` call in `larpnet_matrix_sync_profile()` used
the option key `'header'` (singular) -- Friendica's HTTPClient (a Guzzle
wrapper) actually reads `'headers'` (plural, Guzzle's own
`RequestOptions::HEADERS`), as an **associative** array (`['Name' =>
'value']`, not `"Name: value"` strings -- see `src/Model/GServer.php` for
a confirmed-correct example elsewhere in core). This meant **no header was
ever actually sent on any of these calls**, `Authorization` included.
Login still worked (Synapse's JWT login doesn't require auth), which is
exactly why the SSRF fix above looked like it had worked -- the account
got auto-created, just with Synapse's own bare-localpart default
displayname, because every *authenticated* call after login
(`GET`/`PUT .../profile`, media upload) failed with `M_MISSING_TOKEN`.

If profile sync ever seems inert (or half-working -- account exists but
name never updates) again, check this and the SSRF entry above, not the
three layers earlier in this section -- they were never actually the
problem, twice now.

## Key files

| Path | Purpose |
|---|---|
| `larpnet_matrix.php` | JWT minting/login bridge + same-origin static asset host for `client/dist/` + profile sync. |
| `client/` | The chat client itself (Preact + matrix-js-sdk). `npm run build` (via `build.mjs`) produces `client/dist/`, which is never committed (see `client/.gitignore`) -- built fresh by the `matrix-client-builder` stage in the repo root `Dockerfile`, same "never trust a local copy" rule as `vendor/`. |
| `client/build.mjs` | esbuild bundling + the manual wasm-copy step -- see its own comments for why esbuild's `new URL(..., import.meta.url)` asset convention does **not** apply here (confirmed empirically: esbuild does not support that pattern, unlike Vite/Webpack) and what actually resolves the WASM path instead. |

## Making changes

- If you touch the JWT claim shape or the `window.LARPNET_CHAT_CONFIG` shape
  `larpnet_matrix_content()` injects, update both the PHP side and
  `client/src/matrix.js`/`main.jsx` together -- they're one contract split
  across two languages, not independently versioned.
- Client asset requests are served through `larpnet_matrix_serve_asset()`,
  not nginx -- there is no separate static-file location for this addon in
  `larpnet-config`'s nginx config, by design (same-origin, no CORS/storage
  partitioning concerns to work around).

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

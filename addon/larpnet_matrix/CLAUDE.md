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
crypto-store corruption bug: Friendica is a classic multi-page app, so
embedding chat in an `<iframe>` meant the iframe (and the Matrix client
booting inside it) was destroyed and recreated on every Friendica page
navigation, racing the browser's IndexedDB teardown for the crypto store
against the next boot's open. Building this addon's own client instead of
depending on Element Web gave us the two changes needed to actually fix
that: (1) `js/matrix-chat-widget.js` now opens chat in its own **popup
window**, not an iframe, so the chat client's browsing context survives
Friendica page navigations; (2) this client never hand-seeds a previous
session's tokens into storage the way the old SSO bridge page did -- every
open does one real, fresh JWT login (see `client/src/matrix.js`), so the
only code path ever exercised is the well-tested login -> initRustCrypto ->
startClient sequence, never a shortcut around it.

## Why there's no device-verification UI

The client (`client/src/matrix.js`) initializes rust-crypto and starts the
client, but never bootstraps cross-signing or secret storage, and never
shows Element-style "Verify this device" prompts. This is deliberate, not
an oversight:

- A single device can encrypt and decrypt messages in a room it's a member
  of without ever setting up cross-signing. Cross-signing/verification only
  establishes *trust between multiple devices* -- irrelevant to this
  client's actual usage pattern (one browser, one device, one popup
  window), so there's no UI to build for it in v1.
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

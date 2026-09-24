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

## Why there's no interactive device-verification (SAS/emoji) UI

The client never shows Element-style "Verify this device by comparing
emoji" prompts. A single device can encrypt and decrypt messages in a room
it's a member of without that -- interactive verification establishes
*trust between two devices currently online together*, which is a
different feature from cross-device history recovery (see below, which
this client *does* now implement).

**Do not "fix" this by having this addon mint or derive a secret-storage/
recovery key itself** (e.g. from the same JWT secret used for login). That
was tried in the old Element-embedding design (a
`larpnet_matrix_recovery_key()` function, since removed) and is a bad idea
independent of whether it works: if the operator can compute a user's
secret-storage recovery key, the operator can decrypt that user's backed-up
message history, which defeats E2EE's confidentiality guarantee against us
specifically. The recovery key `client/src/recovery.js` generates is always
client-side (`crypto.createRecoveryKeyFromPassphrase()`), shown to the user
once, and never sent to or knowable by this addon's PHP side.

## `initRustCrypto()` needs a per-(account, device) `cryptoDatabasePrefix`

`matrix.js`'s `loginAndStart()` passes
`cryptoDatabasePrefix: \`${res.user_id}::${res.device_id}\`` to
`client.initRustCrypto()`. **Do not drop this, and do not rename the key
to `storePrefix`** -- `storePrefix` is only the name of the *lower-level*
`rust-crypto/index.js` parameter this gets translated into internally;
passing `storePrefix` directly to the public `client.initRustCrypto()` is
silently ignored (unknown key on a plain object, no error). This is not
hypothetical -- it's exactly what the first attempt at this fix did, and
it shipped and was live-verified as still broken (`indexedDB.databases()`
in a real browser still showed only the old fixed-name database after
deploying it) before the key name was corrected.

Leaving this option unset (or wrong) makes matrix-js-sdk open one
hardcoded-named IndexedDB database shared by *every* account and *every*
device on this origin. Discovered live, the hard way, in two forms:
- Switching Friendica accounts in the same browser without a full storage
  wipe crashed with `Error: the account in the store doesn't match the
  account in the constructor` -- the new account's client tried to open the
  previous account's now-mismatched store.
- Separately, chat login hung *indefinitely* at "Opening Rust CryptoStore"
  in a **completely fresh tab with a freshly-generated device id** -- some
  *other* tab anywhere in the browser (any account, any device) still had
  that one shared store open, and IndexedDB's own `onblocked` semantics
  don't time out on their own. Clearing `localStorage`/IndexedDB in the
  stuck tab didn't help, because the block was held by a *different* tab
  this client has no way to see or close.

Per-(account, device) store names make every login open its own
independent database, so no login can ever be blocked by, or corrupt, any
other account's or device's store -- this isn't a workaround, it's the
actual fix; the bug was never about "a stray tab," it was about not
namespacing the store at all.

## Cross-device key recovery (`client/src/recovery.js`)

Each browser/profile is a separate Matrix "device" with its own independent
E2EE identity. Without cross-signing + key backup, a new device (or the
same account in a different browser) can never decrypt messages from
before it existed -- confirmed as a real, reported problem (a user's own
message showed as undecryptable in a second browser). `recovery.js` fixes
this with the standard Matrix answer: a client-side-generated recovery key
("Security Phrase" in Element terms) that encrypts a server-side backup of
room keys. `App.jsx` drives two flows off `getRecoveryStatus()`:

- **`needs_setup`** (first ever device for this account): `setUpRecovery()`
  bootstraps cross-signing + secret storage + key backup, and returns the
  generated key for `RecoveryKeyModal` to show the user exactly once. We
  keep no copy anywhere -- if they lose it, see the last bullet below.
- **`needs_restore`** (secret storage already exists remotely, this device
  just doesn't have the key yet): `RecoveryKeyModal` prompts for the
  existing recovery key; `restoreFromRecoveryKey()` decodes it, calls
  `loadSessionBackupPrivateKeyFromSecretStorage()` then `restoreKeyBackup()`.
  Skippable -- the device still works for *new* messages either way, but
  see the next section for what "still works" actually means for a
  skipped device's own *outgoing* messages.

**`getRecoveryStatus()`'s per-device check, and why `isSecretStorageReady()`
is the wrong one -- confirmed live, this was shipped broken once already:**
`crypto.isSecretStorageReady()` is an ACCOUNT-level check -- once *any*
device has ever bootstrapped secret storage, it returns `true` on *every*
device of that account forever after, including ones that have never
unlocked it themselves. A version of this file that gated on it sent a
brand-new device straight to `'ready'` with **no prompt at all**, while
that device was completely unable to decrypt anything -- confirmed by
sending a real message from that "ready" device to another account, then
opening a genuinely fresh third device and getting
`"Nie można odszyfrować wiadomości"` with no way to fix it through the UI.
The correct per-device signal is `getActiveSessionBackupVersion()`: `null`
until *this specific device* has actually loaded/enabled the backup
decryption key -- which is also, not coincidentally, exactly what decides
whether *this device's own outgoing messages* get uploaded to key backup
at all (a device that was never given the recovery key can encrypt and
send fine, but its messages are then just as unrecoverable to *any* other
device, including future ones, as the history it can't read itself).

**`restoreKeyBackup()` needs a separate priming call first, or it silently
finds nothing to restore:** calling it right after caching the recovery key
(via `getSecretStorageKey`) throws `"No decryption key found in crypto
store"` -- confirmed live. The actual backup decryption key is a
*different* secret (`m.megolm_backup.v1`) that must first be pulled out of
secret storage with `loadSessionBackupPrivateKeyFromSecretStorage()`
(which is also what makes `getActiveSessionBackupVersion()` go non-null).
Only `resetKeyBackup()` -- called internally by `setUpRecovery()`'s
`bootstrapSecretStorage({ setupNewKeyBackup: true })` -- generates and
caches that key directly, which is why the device that runs *setup*
doesn't need this extra step but every device that *restores* does.

**Empirically confirmed against `test.larpnet.pl`'s Synapse this session
(important, non-obvious constraints for anyone touching this again):**

- A **first-ever** `POST /keys/device_signing/upload` for an account needs
  no User-Interactive-Auth (UIA) at all, even though this addon's accounts
  are JWT-only (no password ever set). This is why `setUpRecovery()`'s
  `authUploadDeviceSigningKeys` callback can just do `makeRequest({})` and
  succeed.
- **Overwriting *existing* cross-signing keys is a different story**:
  Synapse demands a UIA stage for that, and a JWT-only account has *none*
  available (`flows: []` in the 401 body) -- there is no `m.login.dummy`
  fallback offered here. **Never call `client.getCrypto().resetEncryption()`**
  (or otherwise try to re-bootstrap cross-signing on an account that already
  has it) -- it is not just blocked, it is destructive on failure: confirmed
  live that a failed reset can delete the account's existing key backup
  (an early, UIA-free step in `resetEncryption()`'s sequence) *before*
  hitting the UIA wall on cross-signing, leaving the account with no key
  backup and no way to create a new one via the client either. `setUpRecovery()`
  must only ever be called when `getRecoveryStatus()` says `needs_setup`
  (i.e. cross-signing/secret storage have *never* existed for this account)
  -- that check is the whole safety mechanism.
- **If a user genuinely loses their recovery key** (and it isn't cached on
  any still-logged-in device), there is currently no clean client-side way
  to rotate it for a JWT-only account, for the same UIA reason -- this is a
  real, accepted limitation, not a bug to silently work around. The one
  remaining path (not yet built, flagged here for whoever needs it next):
  from a device that still has cross-signing ready locally,
  `bootstrapSecretStorage({ setupNewSecretStorage: true, setupNewKeyBackup: true, ... })`
  rotates *just* the secret-storage key without touching cross-signing at
  all, which should avoid the `device_signing/upload` UIA wall entirely --
  untested this session (the test account's cross-signing state got
  scrambled by the failed `resetEncryption()` experiment above before this
  could be verified live).

## Chat header shows who you're talking TO, never your own name

`App.jsx`'s header briefly showed `config.displayName` (the *viewer's* own
larpnet name, injected by `larpnet_matrix_content()`) -- backwards: a chat
header should say who you're talking to, not remind you who you are. Fixed
by computing the header title from the selected room via the same
`roomDisplayName()` helper the room list already used (moved into
`matrix.js` so both share it), and dropping the now-unused
`config.displayName` field entirely (`larpnet_matrix_content()` no longer
injects it). If this regresses, check that the header is deriving its title
from `client.getRoom(selectedRoomId)` + `roomDisplayName()`, not from
anything describing the logged-in user.

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
| `client/src/recovery.js` | Cross-device E2EE history recovery (recovery-key setup/restore) -- see "Cross-device key recovery" above. |

## Making changes

- If you touch the JWT claim shape or the `window.LARPNET_CHAT_CONFIG` shape
  `larpnet_matrix_content()` injects, update both the PHP side and
  `client/src/matrix.js`/`main.jsx` together -- they're one contract split
  across two languages, not independently versioned.
- Client asset requests are served through `larpnet_matrix_serve_asset()`,
  not nginx -- there is no separate static-file location for this addon in
  `larpnet-config`'s nginx config, by design (same-origin, no CORS/storage
  partitioning concerns to work around).

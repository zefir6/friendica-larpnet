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
  existing recovery key; `restoreFromRecoveryKey()` decodes it and runs
  all three steps in the next section below, in order. Skippable -- the
  device still works for *sending* new messages either way, but (until
  this three-step dance completes) those messages won't be recoverable by
  *any* device either, including this account's own future devices -- see
  below for why.

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
decryption key.

**`restoreFromRecoveryKey()` is three steps, not two -- confirmed live,
shipped broken *twice* before landing correctly:**
1. `loadSessionBackupPrivateKeyFromSecretStorage()` -- reads the actual
   backup decryption key (a *different* secret, `m.megolm_backup.v1`) out
   of secret storage using the recovery key, and caches it locally.
   Skipping this makes step 2 throw `"No decryption key found in crypto
   store"` even with the right recovery key already cached via
   `getSecretStorageKey` -- confirmed live. This is also what makes
   `getActiveSessionBackupVersion()` go non-null.
2. `restoreKeyBackup()` -- downloads and decrypts whatever *other*
   devices have already backed up. The "read old history" half.
3. **`bootstrapCrossSigning()`, called again** -- easy to assume this
   step is unnecessary once 1-2 succeed, since `getRecoveryStatus()`
   already reports `'ready'` at that point. It's not: without it,
   `crypto.checkKeyBackupAndEnable()` keeps reporting the backup as
   *untrusted* (confirmed live: `[RustBackupManager] Key backup present
   on server but not trusted: not enabling key backup`, repeating on
   every sync), which means this device's own *new* outgoing messages
   are silently never uploaded to backup either -- steps 1-2 alone only
   fix reading, not being read *from* in the future. Calling
   `bootstrapCrossSigning()` again on a device that didn't create the
   keys is safe specifically because secret storage is already unlocked
   at this point: the SDK takes a different, UIA-free internal path that
   just imports and caches the existing keys locally (confirmed live via
   its own log line: `"Cross-signing private keys not found locally, but
   they are available in secret storage, reading storage and caching
   locally"`) -- it does not attempt to create or overwrite anything, so
   this is not the same operation as `setUpRecovery()`'s first-ever call
   and does not carry the same "never call this on an account that
   already has keys" warning that applies to `resetEncryption()`.
   Isolated and verified safe in a disposable Node script against the
   real account *before* this was ever tried live, given how badly the
   `resetEncryption()` experiment went earlier this session.

Only `resetKeyBackup()` -- called internally by `setUpRecovery()`'s
`bootstrapSecretStorage({ setupNewKeyBackup: true })` -- generates and
caches the backup decryption key directly *and* establishes trust in one
call, which is why the device that runs *setup* doesn't need any of this
three-step dance but every device that *restores* does.

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
- **Resetting the recovery key on purpose (`resetRecovery()`, exposed in
  Settings) -- built and confirmed live, this section previously flagged
  it as untested:** from a device that already has cross-signing ready
  locally, `bootstrapSecretStorage({ setupNewSecretStorage: true, setupNewKeyBackup: true, createSecretStorageKey: ... })`
  rotates *just* the secret-storage key and the key-backup version, without
  touching cross-signing at all -- confirmed live to avoid the
  `device_signing/upload` UIA wall entirely, exactly as this section
  originally guessed. This is also the fix for "a user genuinely loses
  their recovery key": there's no way to recover the *old* one, but this
  device (already unlocked) can issue a fresh one at any time.

  **One non-obvious extra step:** resetting the backup version alone is
  not enough to stop a *brand-new* message from leaking under the old
  session. The room's *currently active* megolm outbound session survives
  the reset untouched, and the very next message sent in that room
  re-uploads that *same* session to the fresh backup version. Fixed by
  calling `crypto.forceDiscardSession(roomId)` for every joined room
  *before* the `bootstrapSecretStorage()` call, forcing a genuinely new
  outbound session on the next send. `resetRecovery()` does this for every
  currently-joined room; don't drop it if this is ever refactored.

  **What this reset does *not* achieve, confirmed by live-testing the
  deployed feature on test.larpnet.pl (not just a spike) -- read the UI
  copy literally, it undersells this correctly:** `forceDiscardSession`
  only stops *new* messages from reusing the old session. It does nothing
  about the *inbound* sessions the resetting device already holds locally
  for messages it has already decrypted -- and that device's ordinary
  background key-backup upload keeps re-archiving those already-cached
  sessions into the fresh backup version as it runs. In a live test, a
  genuinely fresh device (new device_id, empty crypto store, confirmed via
  network trace) that restored via the *new* passphrase right after a
  reset could still decrypt every pre-reset message, not just post-reset
  ones -- because the still-logged-in resetting device had already
  re-uploaded them. Explicitly discussed with the user and this is fine:
  the intended use case for this feature is "I forgot my old
  passphrase/key and want to set a new one," not "shred my history on
  every device." A device that already has the keys locally is *supposed*
  to keep working after a reset -- that's a feature, not a leak. Achieving
  a real history-shred (matching what e.g. Element's "reset cryptographic
  identity" flow does) would require the resetting device to also discard
  its own local crypto store and become a new device_id/login, which
  `resetRecovery()` deliberately does not do. Don't "fix" this without
  raising it with the user first -- it was a deliberate call, not an
  oversight.
- **User-chosen passphrases, not just random keys (`setUpRecovery()`/
  `resetRecovery()`'s optional `passphrase` argument) -- built and confirmed
  live:** `crypto.createRecoveryKeyFromPassphrase(passphrase)` derives the
  real secret from the phrase via PBKDF2 (per the Matrix spec) and stores
  the salt/iterations -- not the phrase -- in the key's public metadata.
  `restoreFromRecoveryKey()` tries the input as an encoded recovery key
  first, and if that fails to decode, re-derives it as a passphrase using
  `deriveRecoveryKeyFromPassphrase()` against that same public metadata.
  Confirmed live: the derived bytes exactly match the original private key.
  Still entirely client-side either way -- this addon's PHP side never
  sees the phrase any more than it ever saw the random key.

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

## Push notifications: custom Matrix push gateway, not Sygnal

`POST /larpnet_matrix/push` implements the Matrix Push Gateway API
(https://spec.matrix.org/latest/push-gateway-api/) directly in this addon,
for the native iOS/Android clients' background message notifications.
Deliberately not a separately deployed Sygnal instance -- the contract is
one HTTP call in (`{notification: {event_id, room_id, counts, devices: [...]}}`),
one JSON object out (`{rejected: [...]}`), and both delivery backends (FCM,
APNs) already need hand-rolled provider-auth signing code in this
codebase regardless (see `addon/larpnet_fcm`'s RS256 JWT and
`larpnet_matrix_apns_jwt()`'s ES256 JWT) -- running a whole extra Python
service for one HTTP relay would be more deployment surface for no real
benefit. See `larpnet_matrix_push_notify()`'s own doc comment for the
full request/response shape.

**Auth**: a shared secret (`LARPNET_MATRIX_PUSH_SECRET` env var, same
per-deployment convention as `LARPNET_MATRIX_JWT_SECRET`) passed as
`?key=` on the URL a client registers as its pusher's `data.url` --
Synapse itself defines no gateway-auth mechanism (a gateway is normally
just trusted once a homeserver is configured to reach it), so this is
defense in depth against something unrelated on the internet triggering
FCM/APNs sends through this endpoint, not a real trust boundary between
us and our own homeserver.

**App ID contract**: `LARPNET_MATRIX_APP_ID_ANDROID` (`pl.larpnet.android`)
and `LARPNET_MATRIX_APP_ID_IOS` (`pl.larpnet.ios`) are the exact `app_id`
values each native client must register with Synapse
(`POST /_matrix/client/v3/pushers/set`) -- a cross-repo contract, the same
way `OAUTH_REDIRECT_URI` has to byte-for-byte match between
`larpnet-android` and this server. `pushkey` is simply the raw FCM
registration token (Android) or APNs device token (iOS); this gateway is
stateless and keeps no registration table of its own -- Synapse's own
pusher table is the only place that mapping lives, which is also why a
dead pushkey just gets returned in `rejected` rather than looked up or
deleted anywhere here.

**How a client learns this gateway's own URL**: `push_gateway_url` in
`larpnet_matrix_identity()`'s response (so both `larpnet_matrix_content()`
for web and `larpnet_matrix_post()` for native apps carry it, though only
native apps register a pusher at all) -- computed by
`larpnet_matrix_push_gateway_url()` as this site's own base URL plus
`?key=<LARPNET_MATRIX_PUSH_SECRET>`, or null if the secret isn't
configured. The secret is deliberately never handed to a client on its
own: only this pre-built URL, since the client ships inside a public app
binary and must never be able to reconstruct or leak the raw secret in
isolation. Each native client's pusher registration sets
`data.format = "event_id_only"` on the Matrix side too (`PushFormat.EVENT_ID_ONLY`
in the Kotlin/Swift bindings) -- redundant with this gateway only ever
forwarding `event_id`/`room_id` regardless, but it's the flag that makes
Synapse itself omit full content from the `/push/v1/notify` call in the
first place, so both layers agree on the same "never send content"
guarantee independently.

**Never leaks plaintext to Apple/Google.** For Android: only `event_id`/
`room_id` go into the FCM message, and it's sent via
`larpnet_fcm_send_data_message()` (data-only, no `notification` block) --
never the existing `larpnet_fcm_send_to_tokens()`, which always includes
a real plaintext title/body and exists only for classic Friendica
notifications. For iOS: the APNs alert text is always the same static
placeholder (`"Larpnet" / "New message"`) with `mutable-content: 1`, so
Apple's servers see nothing beyond that placeholder -- the real
sender/preview is filled in on-device by the Notification Service
Extension after it decrypts the referenced event locally via
MatrixRustSDK's `NotificationClient`, same pattern Element X's iOS client
uses for encrypted rooms. A pure `content-available`-only background push
was deliberately not used instead: it doesn't invoke the NSE for content
modification and has no delivery-time guarantee, whereas an alert push
does both.

**Config: env vars, same as this addon's other `LARPNET_MATRIX_*` settings**
(deliberately not admin-config the way `larpnet_fcm`'s
`fcm_service_account_json` is -- both are valid places in this codebase
for a secret to live, this one just follows the convention already
established for everything else `larpnet_matrix_settings()` reads,
rather than introducing a second pattern):
- `LARPNET_MATRIX_APNS_KEY_ID`, `LARPNET_MATRIX_APNS_TEAM_ID` -- plain
  strings from the Apple Developer portal's Keys page.
- `LARPNET_MATRIX_APNS_KEY_PEM_B64` -- the `.p8` file's contents,
  **base64-encoded** (`base64 -i AuthKey_XXXX.p8 | tr -d '\n'`), not the
  raw PEM: a `.p8` key is multi-line, and a literal embedded newline in
  a `.env` file's value isn't reliably supported across every
  parser/deployment tool in this project's chain (docker compose,
  systemd `EnvironmentFile`, ...). `larpnet_matrix_apns_send()`
  `base64_decode()`s it back before use.
- `LARPNET_MATRIX_APNS_TOPIC` -- optional, defaults to `pl.larpnet.ios`.
- `LARPNET_MATRIX_APNS_USE_SANDBOX` -- optional bool (`true`/`1`),
  defaults false/production. Only set this for a build run straight
  from Xcode onto a device with a development provisioning profile --
  TestFlight and App Store builds both use the production APNs
  environment regardless of which internal/external track they're on.

Same Apple Developer account/app either way, so (unlike
`LARPNET_MATRIX_JWT_SECRET`, deliberately per-deployment since test and
prod are separate Matrix homeservers with separate user data) these five
vars are the same values on both `test.larpnet.pl` and prod once both
are wired for push -- no need to mint a second APNs key for test.

**The DER-to-raw ECDSA signature conversion
(`larpnet_matrix_der_ecdsa_to_raw()`) is not optional and easy to get
wrong.** `openssl_sign()` on an EC key always produces a DER-encoded
signature (a SEQUENCE of two INTEGERs); JWS ES256 (what APNs' auth JWT
requires) instead needs the raw, fixed-width 64-byte R||S concatenation.
A DER signature handed to APNs as-is is simply rejected -- there is no
PHP built-in for this conversion. Verified correct via 200 real
sign/convert/reconstruct-DER/`openssl_verify()` round trips in a scratch
script before this shipped (not just eyeballed against the RFC), since a
subtly wrong byte-padding here would silently produce a JWT that fails
verification 100% of the time in production while looking
completely fine in code review.

## Key files

| Path | Purpose |
|---|---|
| `larpnet_matrix.php` | JWT minting/login bridge + same-origin static asset host for `client/dist/` + profile sync + the push gateway (`POST /larpnet_matrix/push`, see above). |
| `client/` | The chat client itself (Preact + matrix-js-sdk). `npm run build` (via `build.mjs`) produces `client/dist/`, which is never committed (see `client/.gitignore`) -- built fresh by the `matrix-client-builder` stage in the repo root `Dockerfile`, same "never trust a local copy" rule as `vendor/`. |
| `client/build.mjs` | esbuild bundling + the manual wasm-copy step -- see its own comments for why esbuild's `new URL(..., import.meta.url)` asset convention does **not** apply here (confirmed empirically: esbuild does not support that pattern, unlike Vite/Webpack) and what actually resolves the WASM path instead. |
| `client/src/recovery.js` | Cross-device E2EE history recovery (recovery-key setup/restore/reset) -- see "Cross-device key recovery" above. |
| `client/src/RoomInfoModal.jsx` | Per-conversation member list (add/remove) + rename (group rooms only) + leave. Plain Matrix Client-Server API wrappers (`client.invite`/`kick`/`leave`/`setRoomName`) -- no crypto involved, no UIA surprises like the recovery-key flows above. |
| `client/src/SettingsModal.jsx` | Currently just the "reset recovery key" entry point (confirm-then-delegate to `recovery.js`'s `resetRecovery()`). |

## Making changes

- If you touch the JWT claim shape or the `window.LARPNET_CHAT_CONFIG` shape
  `larpnet_matrix_content()` injects, update both the PHP side and
  `client/src/matrix.js`/`main.jsx` together -- they're one contract split
  across two languages, not independently versioned.
- Client asset requests are served through `larpnet_matrix_serve_asset()`,
  not nginx -- there is no separate static-file location for this addon in
  `larpnet-config`'s nginx config, by design (same-origin, no CORS/storage
  partitioning concerns to work around).

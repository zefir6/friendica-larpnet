# Avatar upload persistence — debugging log and handoff

Written for whoever (human or Claude instance) picks this up next. Status as of
2026-09-09: **not resolved**. Two real server-side bugs were found and fixed
along the way, but the underlying report — uploading a new avatar via the API
doesn't end up visible on the web — still reproduces on production after both
fixes, in a new form. This file is the full trail: what was tried, what was
found, what's fixed, and what's still open.

## Symptom history, in order

1. **Original report**: changing the avatar photo in the Larpnet iOS app
   "doesn't seem to work."
2. **First (wrong) diagnosis**: client-side UI staleness — `ProfileView`
   wasn't refreshing after popping back from Edit Profile, and the image
   cache wasn't being invalidated. Fixed (reload-on-reappear, cache
   eviction). This made the app *look* like it worked, but the user then
   checked larpnet.pl's own web UI directly and confirmed the change
   **did not actually persist server-side**. The client-side fixes were
   real bugs but not the bug.
3. **Second diagnosis**: `PATCH api/v1/accounts/update_credentials`'s avatar
   handling goes through Friendica's own hand-rolled multipart-over-PATCH
   parser (`HTTPInputData`), since PHP doesn't natively populate `$_FILES`
   for non-POST methods. Hypothesis: that parser was silently failing.
   Switched the iOS client to the legacy Twitter-compatible
   `POST api/account/update_profile_image` instead, which uses PHP's native
   `$_FILES` (real POST multipart) and does throw a real error on failure.
   **This did not fix it either** — same "looks fine in-app, not visible on
   web" symptom persisted.
4. **Found the client-side blind spot**: `EditProfileViewModel.uploadAvatar`
   was unconditionally seeding the local image cache with the just-cropped
   photo under whatever avatar URL the server returned, regardless of
   whether the server actually changed anything. Every "does it look right
   in the app" check up to this point was measuring nothing — the app would
   show the new photo locally even on a complete server-side no-op. Fixed by
   fetching the real avatar bytes from the network (bypassing all caches)
   before and after upload and only accepting success if they actually
   differ. See `larpnet-ios` commits on `fix/avatar-server-persistence`
   (now merged) for the client-side detail.
5. **With that fix in place, the app started reporting a real error**: *"The
   server accepted the upload but didn't actually change your avatar."*
   This was the first real signal from the server, confirmed on production
   `larpnet.pl` with the byte-comparison diagnostic.
6. **Root cause #1, found and fixed**: `Photo::uploadAvatar()`
   (`src/Model/Photo.php`) stores the new avatar's image rows at scales
   4/5/6 correctly, but never sets `profile = true` on the new resource-id —
   it only clears that flag on the *old* one. Every place that resolves
   "the current avatar" (`Contact::updateSelfFromUserID()`,
   `User::getAvatarUrl()`, `Module\Photo`'s own serving logic) looks up the
   photo row where `profile = true`. After an API-driven upload, no row had
   that flag at all, so the lookup found nothing and silently kept serving
   whatever was there before. Confirmed by diffing against the web UI's own
   working crop flow (`Module/Settings/Profile/Photo/Crop.php`), which
   already does the update-after-store correctly — that's why uploading
   through the website worked while the API (used by every app) didn't.
   Fixed in `fix/avatar-profile-flag-not-set`, merged to `larpnet-test` as
   PR #59, then to `larpnet` (prod) as PR #60, released as
   `release-2026.09.09`.
7. **Tested on the fresh `test.larpnet.pl` stack**: hit an unrelated,
   unresolved issue — the upload endpoint returned a flat `HTTP 500` with an
   **empty body**, reproduced identically with two different source images
   (a flat-color PNG and a real JPEG), so not image-content-specific. The
   user checked and found **nothing in Friendica's application log** for
   this. An uncaught PHP exception normally *is* caught and logged by
   Friendica's own handler, so an empty-body 500 with nothing in the app log
   is more consistent with something dying below the application layer —
   e.g. a PHP-FPM worker crash/OOM — than with a bug in the fix itself.
   Given the test stack's own handoff doc
   (`larpnet-config/TEST_ENVIRONMENT_HANDOFF.md`) already flags it as
   freshly provisioned and "possibly needing a restart even after that,"
   this was treated as a probable infrastructure issue on that specific
   stack, not evidence against the fix. **This was a judgment call to
   deploy past, not a confirmed diagnosis** — see "Open questions" below.
8. **Deployed root cause #1's fix to production** (`release-2026.09.09`).
   **Reproduces on prod too, but differently than before**: no error shown
   client-side (the byte-comparison diagnostic now passes — the served
   bytes genuinely changed), so something really did happen server-side.
   But the new photo is **not visible on the web UI**, and notably **the
   old photo disappears too** — not "nothing changed," but "something
   changed to a broken/empty state." This is the current, unresolved
   symptom.

## Current hypothesis for the still-open bug (step 8), unverified

`Photo::store()`'s return value only reflects the **database** write
succeeding (`DBA::update`/`DBA::insert`) — it does not verify that the
actual image bytes were written correctly by the storage backend:

```php
// src/Model/Photo.php, inside store()
$img_str = $image->asString();
...
try {
    $backend_ref = $storage->put($img_str, $backend_ref);
} catch (InvalidClassStorageException) {
    $data = $img_str;
}
$fields = [..., 'data' => $data, 'backend-ref' => $backend_ref, 'backend-class' => (string) $storage, ...];
$r = DBA::update(...) / DBA::insert(...);
return $r;
```

If `$storage->put()` fails in a way that doesn't throw (or throws something
other than `InvalidClassStorageException`, which is the only case handled
here), the DB row can still be written successfully with a `backend-ref`
that points at nothing, or with empty/corrupt `data`. That would explain
exactly what's now observed: `profile = true` correctly points at the new
resource (root cause #1 is genuinely fixed — the *pointer* updates), but the
bytes behind it are missing or broken, so:

- The URL construction changes (a real, new resource-id + timestamp), which
  is why the **old** photo stops being served under the old identity.
- The **new** photo doesn't render, because there's nothing valid behind the
  new resource-id/backend-ref.

**This is a hypothesis, not a confirmed diagnosis.** It has not been
verified against the actual `photo` table rows or storage backend state on
either `larpnet.pl` or `test.larpnet.pl` — see "What I could not check"
below for why.

An alternative/adjacent hypothesis: this could be the *same* underlying
issue as the `test.larpnet.pl` empty-body-500 (i.e. the storage backend
write is fragile or broken on both environments, and prod's version of the
same failure just doesn't happen to throw fatally). Worth checking whether
prod and test share a storage backend configuration.

## What's confirmed fixed vs. still open

**Fixed and confirmed:**
- Client no longer lies about upload success (byte-comparison diagnostic,
  `larpnet-ios`).
- `Photo::uploadAvatar()` now correctly marks the new upload's rows as the
  active profile photo (`profile = true`) — confirmed via code review
  against the known-working web UI path, and confirmed the *pointer* change
  takes effect (old photo's identity is abandoned) on prod post-release.

**Still open:**
- The new avatar's actual image bytes are not ending up visible/servable
  after upload, on production, post-fix. Leading hypothesis above, not
  verified.
- The `test.larpnet.pl` empty-body HTTP 500 — never root-caused. May or may
  not be the same bug as the above.

## What I could not check, and why

- **No SSH/host access.** The actual Friendica app runs in Docker containers
  on a host I don't have credentials for (an `id_larpnet_claude` SSH key
  exists in the parent directory, but no host/IP was ever available to use
  it against). I could not read PHP-FPM's own error log, `docker logs
  friendica-app`/`friendica-app-test`, or inspect the storage backend
  (filesystem/S3/whatever it's configured as) directly.
- **No direct DB access.** Could not query the `photo` table directly to
  check whether the new resource-id's rows have a valid `backend-ref`/`data`
  after an upload that "looks like it worked" per the byte-comparison
  diagnostic but isn't visible on the web.
- **Raw `curl`-based OAuth login against larpnet.pl/test.larpnet.pl does not
  work**, and this cost real time this session before being abandoned both
  times. `POST /login` returns a normal-looking `302` to `/`, but the
  resulting session cookie is never actually authenticated (confirmed by
  re-fetching the homepage afterward and finding the login form still
  present). HTTP Basic Auth against the legacy Twitter-compatible API is
  also flatly rejected (`401 This API requires login`) even with a
  browser-like `User-Agent` that clears Cloudflare's bot check for GET
  requests. The `password` OAuth grant type is not supported at all
  (`invalid_client`) — Friendica's OAuth server only implements
  `authorization_code`. Best guess: Cloudflare's bot management does more
  than check the `User-Agent` header (likely a JS challenge or TLS
  fingerprinting) that only a real WebView (what `ASWebAuthenticationSession`
  uses, and what the app's real login flow goes through) can pass. **Do not
  re-attempt this without a new idea** — it failed identically on two
  different instances this session.
- **Given the above, all live verification this session went through the
  real iOS app** (manual testing by the user, and a throwaway automated
  XCUITest — see below) rather than direct API calls, which is slower and
  gives less granular signal (e.g. no way to see the raw HTTP response body
  for the upload call beyond what the client's own error message exposes).

## Diagnostic tooling left behind

- **`larpnet-ios` branch `fix/avatar-server-persistence`** (merged): the
  byte-comparison verification in `EditProfileViewModel.uploadAvatar` and
  `ImageLoader.fetchFresh` (in `RemoteImage.swift`) are real, permanent
  fixes — not just diagnostics — and should stay.
- **`larpnet-ios/LarpnetUITests/AvatarUploadDiagnosticUITests.swift`**: a
  throwaway XCUITest that drives the full real login (via
  `ASWebAuthenticationSession`, same as `LoginFlowUITests.swift`) + avatar
  crop/upload flow end to end against whatever `preferred_instance` is set
  to, and dumps every on-screen static text (so the exact error message,
  if any, ends up in the test log) plus screenshots at each step. Useful
  for reproducing this without needing a human to relay screenshots back and
  forth. **Not part of the regular suite — delete once this investigation is
  closed, or keep if it seems worth formalizing.**
  - Run against a specific instance by first seeding
    `preferred_instance` via
    `xcrun simctl spawn <device> defaults write pl.larpnet.ios preferred_instance -string "<host>"`
    (must be set before first login on a clean/erased simulator — it's a
    "takes effect on next login" setting, same as the real Settings UI).
  - Credentials via `TEST_RUNNER_LARPNET_TEST_USERNAME` /
    `TEST_RUNNER_LARPNET_TEST_PASSWORD` **exported in the shell before**
    calling `xcodebuild test` (not as trailing `xcodebuild` arguments — that
    silently doesn't work, cost a wasted run this session).
  - A photo needs to exist in the simulator's library first:
    `xcrun simctl addmedia <device> <path-to-image>`.
  - The PHPickerViewController's first-run "Private Access to Photos" banner
    puts its own icon `Image` ahead of any real photo cell in accessibility
    query order — a plain `.images.firstMatch` taps the banner, not a photo.
    The test works around this with a fixed normalized-coordinate tap
    instead.
- **Diagnostic simulator**: `iPhone 17`, device id
  `400216A8-4768-4F11-8643-73BE1F893542`, was fully erased this session to
  get a clean login state and is currently logged into `test.larpnet.pl`
  as `scibor_jelen`.
- Scratch curl scripts used for direct API probing (Basic Auth, OAuth
  app-registration, the failed password-grant/web-login attempts) are under
  the session's scratchpad directory, not checked into either repo.

## Suggested next steps

1. **Get read access to the `photo` table** (or ask someone who has it) for
   the account used in the most recent prod test, filtered to the most
   recent `resource-id` for that `uid`. Check whether `data`/`backend-ref`
   look populated and whether `backend-class` matches the configured
   storage backend. This would directly confirm or rule out the storage
   hypothesis above without needing host access.
2. **Get PHP-FPM's own error log** (not just Friendica's app-level log) for
   the timestamp of a reproduction, on both `larpnet.pl` and
   `test.larpnet.pl`. If the `test.larpnet.pl` empty-body-500 shows up there
   with a stack trace, it may turn out to be the *same* bug as the prod
   symptom, just failing louder.
3. Check whatever the configured storage backend actually is
   (`DI::storage()` — filesystem vs. a `Storage\Filesystem`/`Storage\Database`
   implementation, or something custom to this fork) and whether it's
   healthy/writable on both environments.
4. If a code-level cause is found, the fix almost certainly belongs
   somewhere in `Photo::store()`'s handling of `$storage->put()`'s result —
   right now a failure there doesn't fail the request; it should.

## UPDATE 2026-09-09: root cause found — it's a deployment gap, not a new bug

A session with host/DB/container access (this one didn't have that — see "What
I could not check" above) found the actual explanation for step 8. **There is
no storage-backend bug.** Root cause #1's fix (the `profile => true` change)
was correct, merged, and successfully built into fresh images on both
`larpnet.pl` and `test.larpnet.pl` (image `Created` timestamps: 2026-09-08,
confirmed via `docker image inspect` on both hosts) — **but the fix never
reached the running application.**

**Why:** the custom `larpnet-entrypoint` wrapper (baked into the
`friendica-larpnet` image, wraps the stock Friendica entrypoint) only
re-copies a **hardcoded whitelist** of "larpnet patch" files from
`/usr/src/friendica` onto the persistent `/var/www/html` volume on every
container start. Friendica's own stock entrypoint separately rsyncs
`/usr/src/friendica → /var/www/html` wholesale, but *only* when it detects an
upstream Friendica core version bump — a same-version patch release (like
this fix) doesn't trigger that. `src/Model/Photo.php` was never added to the
custom whitelist, so on every single container start since the fix was
deployed, the corrected file sat unused inside the image while the **stale,
pre-fix** copy from 2026-09-04 kept being served from the volume — on both
environments, confirmed with a direct `diff` between
`/var/www/html/src/Model/Photo.php` (stale) and
`/usr/src/friendica/src/Model/Photo.php` (fixed) inside both running
containers. The missing hunk was exactly the `profile => true` update this
doc predicted, word for word.

**Immediate hotfix applied (2026-09-09, both `test.larpnet.pl` and
`larpnet.pl`):** copied the image's fixed `/usr/src/friendica/src/Model/Photo.php`
over the stale live copy at `/var/www/html/src/Model/Photo.php` inside each
running container (`friendica-app-test`, `friendica-app`), preserved
ownership/mode, `php -l` verified, then restarted each container to clear
PHP-FPM opcache. Both confirmed healthy afterward (HTTP 200 smoke test). This
should unblock avatar uploads on both right now — **please re-test via the
app and confirm.**

**This hotfix is NOT durable** — it's a one-time value copy on the
bind-mounted volume, not a mechanism. It will silently go stale again the
next time `Photo.php` changes upstream (in the `friendica-larpnet` image
repo) and gets rebuilt/redeployed, for the exact same reason it happened this
time.

### Permanent fix — done

Added `src/Model/Photo.php` to `larpnet-entrypoint.sh`'s always-copy
whitelist, alongside the other `src/Model/*.php` entries. Also audited every
core file this fork currently patches (`git diff upstream/2026.08-rc...larpnet
-- src/ static/ view/lang/`, 29 files) against the whitelist: after this
addition, every one of them is covered — no other instances of this bug
class exist as of 2026-09-09. That audit is a point-in-time check, not a
mechanism — the next person who patches a new core file still has to
remember to add it here, same as today.

This infra-only repo (`larpnet`/`larpnet-test`, Docker Compose config only —
see its `CLAUDE.md`) can't fix this; it has no access to the app's source.

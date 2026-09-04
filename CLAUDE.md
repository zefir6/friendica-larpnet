# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is **LARPnet** — a fork of [Friendica](https://friendi.ca) (an ActivityPub-federated social network) customized for a Polish LARP community. The `develop` branch tracks upstream Friendica; the `larpnet` branch is the production fork. All custom work lives on `larpnet`. When merging upstream Friendica updates, merge `develop` → `larpnet`.

## Development environment

The dev stack is in `.docker/`. Copy `.docker/.dist.env` to `.docker/.env.local` and adjust if needed (defaults work out of the box).

```bash
docker compose -f .docker/compose.yaml up -d   # start stack (nginx + php-fpm + mariadb + redis)
docker compose -f .docker/compose.yaml down     # stop
```

App runs at `http://localhost:8080`. phpMyAdmin at `http://localhost:8086`.

Install PHP deps (needed for linting/tests outside Docker):
```bash
composer install
```

## Common commands

```bash
# Tests
composer test                  # all tests
composer test:unit             # unit tests only
phpunit tests/src/Unit/Object/PostTest.php   # single test file

# Code quality
composer cs:check              # check code style (php-cs-fixer)
composer cs:fix                # auto-fix code style
composer phpstan               # static analysis (src/)
composer phpstan-addons        # static analysis (addon/)
composer phpmd                 # mess detector

# Database schema
composer db:update-structure   # regenerates database.sql from static/dbstructure.config.php
```

## Architecture

### Request lifecycle

`index.php` → `src/App.php` bootstraps the Dice DI container → `src/App/Router.php` dispatches to a `src/Module/**` class → module `run()` renders output.

Routes are declared in `static/routes.config.php` as `'path' => [Module::class, [HTTP_METHODS]]`.

### Dependency injection

All services are accessed via `DI::*()` static methods (`src/DI.php`), which proxy to a [Dice](https://r.je/dice) container. Wire new services in `static/dependencies.config.php`.

### Data layer

- **Models** (`src/Model/`) contain business logic and query the database directly via `DBA` / `Post::select*` helpers.
- **Database schema** is the source of truth in `static/dbstructure.config.php`. Changes there must be followed by `composer db:update-structure` to regenerate `database.sql`.
- Posts are stored across `post`, `post-user`, and related tables (not `item` — that table no longer exists).

### Background workers

`src/Worker/` contains worker classes. Each has a static `execute()` method. Workers are dispatched via `Worker::add()` and run by the background daemon (`bin/console.php daemon`).

### Addon system

Addons in `addon/<name>/` register callbacks with `Hook::register()`. The main hook points are `addon_settings`, `addon_settings_post`, `page_end`, and protocol-level hooks.

### Privacy levels (`src/Model/Item.php`)

| Constant | Value | Behaviour |
|---|---|---|
| `Item::PUBLIC` | 0 | Visible to everyone, federated |
| `Item::PRIVATE` | 1 | Visible to explicitly listed recipients |
| `Item::UNLISTED` | 2 | Unlisted, federated |
| `Item::SERVER_ONLY` | 3 | (**larpnet custom**) "Only Larpnet" — publicly visible, including to anonymous visitors, never federated |

## LARPnet-specific files

All files below are larpnet additions or patches. When rebasing onto a new Friendica release, these need careful conflict resolution.

**Important:** every patched core file must have a corresponding `COPY` line in `Dockerfile` AND an entry in `larpnet-entrypoint.sh`. The Friendica entrypoint only rsyncs files when the Friendica version changes — `larpnet-entrypoint.sh` is a wrapper that unconditionally copies the patched files on every container start so larpnet redeployments always land. `Dockerfile`'s `COPY` list and `larpnet-entrypoint.sh`'s file list are the authoritative source of truth for exactly which files are patched — if this table and those files ever disagree, trust the deploy files and fix the table.

| Path | Purpose |
|---|---|
| `addon/larpnet_banner/` | Per-user profile banner image (uploaded via addon settings, injected as CSS background on profile pages) |
| `addon/larpnet_calendar/` | Generates private iCal subscription URL for each user's events |
| `addon/larpnet_wifi/` | Provisions venue WiFi credentials for larp events; see `scripts/larpnet-wifi-provision.sh`, `scripts/larpnet-wifi.conf.example` and `scripts/larpnet-wifi.cron` for the companion provisioning script and its cron schedule |
| `src/Worker/NtfyPush.php` | Background worker: sends push notification via [ntfy](https://ntfy.sh) when a notification is created. Configured with admin-level `larpnet_notifications/ntfy_url` + `ntfy_token`, per-user `ntfy_topic`. (The `larpnet_notifications` config/pconfig namespace is a settings bucket name, independent of the theme name below.) |
| `src/Worker/NtfyPushMail.php` | Background worker: sends an ntfy push notification when a new direct message arrives, dispatched by the `src/Model/Mail.php` patch below |
| `src/Model/LarpnetPush.php` | Shared ntfy helpers (auto-provision the per-user topic, send to the ntfy relay) used by `NtfyPush`/`NtfyPushMail` and by `LarpnetPushConfig` below |
| `src/Module/Api/Mastodon/LarpnetPushConfig.php` | API endpoint (routed in `static/routes.config.php`) that hands a native client (e.g. the Android app) the ntfy relay URL, its auto-provisioned topic, and a read-only token — the native-client equivalent of what `view/theme/larpnet/theme.php` injects into the browser as `window.LarpnetPush` |
| `addon/larpnet_fcm/` | Firebase Cloud Messaging push for the native Android app, running alongside ntfy. Self-contained: declares its own `fcm-token` DB table via the `dbstructure_definition` hook (picked up next admin-dashboard visit or `bin/console dbstructure update`, no core schema patch needed) and its own registration endpoint (`POST /larpnet_fcm`, OAuth `push` scope) via the legacy addon-module URL dispatch. Sends via FCM's HTTP v1 API with a hand-rolled RS256 JWT + Google OAuth2 exchange (no SDK dependency — see "Building and deploying" note below on why). Configured with admin-level `larpnet_notifications/fcm_service_account_json`. |
| `src/Worker/FcmPush.php` | Background worker: sends the actual FCM push. Kept in core (not the addon) only because `Core\Worker::execute()` hardcodes the `Friendica\Worker` namespace for dispatch — it `require_once`s the addon file to reach the real send logic. This is a hard path coupling: `src/Worker/FcmPush.php` and `addon/larpnet_fcm/` must always be deployed together (both are already in `Dockerfile`/`larpnet-entrypoint.sh`, so this holds as long as no one drops one without the other) |
| `src/Model/Subscription.php` | One-line patch: dispatches `NtfyPush` worker on push subscription notification, plus a `Hook::callAll('push_notification', ...)` that `addon/larpnet_fcm/` hooks into |
| `src/Model/Mail.php` | One-line patch: dispatches `NtfyPushMail` worker on new direct message, plus a `Hook::callAll('push_notification_mail', ...)` that `addon/larpnet_fcm/` hooks into |
| `view/theme/larpnet/` | Main custom theme (based on Frio). Includes Web Push/PWA browser notifications via ntfy (service worker, "Enable notifications" nav button), the "Only Larpnet" ACL visibility panel, and profile-banner integration with `addon/larpnet_banner/`. |
| `src/Protocol/ActivityPub/Transmitter.php` | Patched `createPermissionBlockForItem()` to exclude `SERVER_ONLY` from followers/PUBLIC_COLLECTION recipients |
| `src/Worker/Notifier.php` | Patched `activityPubDelivery()` to skip AP delivery for `SERVER_ONLY` posts entirely |
| `src/Content/Item.php` | Patched `getACL()` to handle `visibility=local` → `private = SERVER_ONLY` |
| `src/Core/ACL.php` | Patched `getFullSelectorHTML()` to pass local option labels and detect existing SERVER_ONLY posts |
| `src/Model/Item.php` | Patched to add `SERVER_ONLY = 3` privacy constant |
| `src/Content/Conversation/PostTemplateBuilder.php` | Patched `fetchPrivacy()` to handle `SERVER_ONLY` — this superseded `src/Object/Post.php` (deleted upstream in a post-rendering rewrite) as of the 2026.08-rc merge; re-apply this same one-line `match` arm if it moves again |
| `src/Module/Item/Compose.php` | Patched to allow the compose page with themes that extend Frio (not just Frio itself) |
| `src/Module/Item/Display.php` | Patched to allow anonymous/logged-out visitors to view `SERVER_ONLY` posts |
| `src/Module/Post/Share.php` | Patched to block sharing of `SERVER_ONLY` posts |
| `src/Module/Privacy/PermissionTooltip.php` | Patched to label `SERVER_ONLY` posts |
| `src/Module/Manifest.php` | Patched to serve larpnet-branded PWA icons for the larpnet theme |
| `src/App/Page.php` | Patched to use larpnet icon as apple-touch-icon default for the larpnet theme |
| `src/Module/FriendSuggest.php` | Upstream bugfix: use the resolved user-contact id instead of the public contact id, fixing a "Contact not found" error when suggesting friends |
| `view/lang/pl/strings.php` | Adds Polish translations for larpnet's custom top-nav labels ("Contacts posts", "Your posts", "People") set via the `nav_info` hook in `view/theme/larpnet/theme.php` — English falls back to the literal `t()` argument, no `view/lang/en/` entry needed |
| `src/Security/Authentication.php` | Upstream bugfix: persist `$return_path` to the session before `setForUser()` may redirect to `/2fa`, so OAuth authorization (and any other `return_path`-carrying login) survives the two-factor detour instead of landing on the site root |
| `src/Module/Api/Mastodon/Statuses.php` | Patched to accept `visibility=local` from Mastodon API clients, mapping to `SERVER_ONLY` — mirrors `Content\Item::getACL()`'s handling of the same value from the classic web compose form |
| `src/Object/Api/Mastodon/Status.php` | Patched to expose `SERVER_ONLY` posts as Mastodon API visibility `local` |
| `src/Module/Api/Mastodon/Conversations.php` | Patched `rawContent()` to enumerate conversations from the caller's own `mail` rows instead of the `conv` table directly — a `conv` row is only ever created under the sender's uid, so the original query returned nothing for conversations the caller only received |
| `src/Factory/Api/Mastodon/Conversation.php` | Patched `createFromConvId()` to resolve the other participant from `mail.contact-id` (invariant across a thread) instead of deriving it from message senders, which returned an empty `accounts` list for a one-way (never-replied-to) thread |
| `src/Module/Api/Mastodon/Conversations/Read.php` | Threads `$uid` through to `createFromConvId()` for the fix above; also fixes an inverted empty-id check that required an id to be *absent* to error |
| `src/Module/Api/Mastodon/Accounts/UpdateCredentials.php` | Upstream bugfix: cast `net-publish`/`manually-approve` (ints from the DB) to bool before returning them as `discoverable`/`locked`, otherwise `BaseModule::getRequestValue()`'s int-coercion branch silently collapsed any incoming `true` to `false` |
| `src/Module/Api/Twitter/DirectMessagesEndpoint.php` | Upstream bugfix: a search term matching an account the caller has no contact relationship with used to silently drop the contact filter and return the caller's entire mailbox instead of zero results |
| `static/routes.config.php` | Registers the `LarpnetPushConfig` API route |

**Why `addon/larpnet_fcm/` hand-rolls FCM instead of using the `kreait/firebase-php` SDK:** that SDK's cache layer (`beste/in-memory-cache`) hard-requires `psr/cache ^2.0||^3.0` at every version, which conflicts with `divineomega/password_exposed`'s `psr/cache ^1.0` pin (used by `src/Model/User.php` for password-breach checking) — a real, unavoidable dependency conflict, not a version-pinning nuance. Bundling the SDK in the addon's own `vendor/` doesn't help either: `Psr\Cache\CacheItemPoolInterface` is a single global PHP class, so whichever `vendor/autoload.php` loads first (root's) wins for the whole request regardless of which addon's `vendor/` tree declares a conflicting version. Resolving this would require bumping `password_exposed` to `^5`, which renamed its namespace (`DivineOmega\PasswordExposed` → `JordJD\PasswordExposed` after a maintainer handoff) — a fork-local patch to security-adjacent core code, for an unrelated push-notification feature. Hand-rolling the ~50 lines of RS256 JWT signing (`openssl_sign()`) and FCM HTTP v1 calls (`DI::httpClient()`) avoided that entirely.

## Building and deploying

Merging to `larpnet` alone does **not** publish anything — publishing to prod requires a deliberate release. After merging:

```bash
git checkout larpnet && git pull
git tag release-$(date +%Y.%m.%d)      # add -2, -3 suffix if releasing more than once a day
git push origin release-$(date +%Y.%m.%d)
```

Pushing a `release-*` tag triggers CI (`.github/workflows/build.yml`), which retags the current `:prod` as `:oldprod` (a one-step rollback target), then builds and publishes the new image as `:latest`, `:prod`, and the immutable `:prod-{GIT_SHA}` (a permanent audit trail of every image ever put in prod).

For a manual/local build:
```bash
cp .env.example .env       # fill in REGISTRY_URL, REGISTRY_USER, REGISTRY_PASSWORD
./build.sh                 # builds and pushes only the versioned tag {FRIENDICA_VERSION}-{GIT_SHA}, e.g. 2026.05-2393b52
./build.sh --release       # also promotes to prod (:latest/:prod/:prod-<sha>, rotating :oldprod) - must be run from larpnet; break-glass equivalent of the release-* tag flow for when CI is unavailable
```

If the registry is behind Cloudflare and upload fails, open an SSH tunnel and set `REGISTRY_PUSH_URL=localhost:5000` in `.env`.

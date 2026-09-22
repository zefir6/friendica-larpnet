# Larpnet

This is a customized fork of Friendica for a Polish LARP community. Custom code and configuration live on the `larpnet` branch (production); `develop` tracks upstream Friendica; `larpnet-test` is the staging branch verified before every production release.

### Building and releasing

Merging to `larpnet` does **not** publish a new production image by itself — publishing requires a deliberate release:

```bash
git checkout larpnet && git pull
git tag release-$(date +%Y.%m.%d)      # add -2, -3 if releasing more than once a day
git push origin release-$(date +%Y.%m.%d)
```

Pushing a `release-*` tag triggers CI, which:
- retags the current `:prod` image as `:oldprod` (a one-step rollback target)
- builds and publishes the new image as `:latest`, `:prod`, and the immutable `:prod-<commit-sha>` (a permanent audit trail of every image ever deployed to prod)

For a manual/local build (requires `.env` with registry credentials — copy `.env.example`):

```bash
./build.sh              # builds and pushes only the versioned tag {FRIENDICA_VERSION}-{GIT_SHA}
./build.sh --release    # also promotes to prod (:latest/:prod/:prod-<sha>) - must be run from larpnet
```

See `CLAUDE.md` for the full development setup, architecture notes, and list of larpnet-specific patches.

## Deploying your own instance

This repo is a genuine, forkable template — not just Larpnet's own private
codebase. A separate community can run their own instance from it:

1. **Prerequisites:** an OCI registry account (Docker Hub, GHCR, or any
   registry `docker/login-action` supports), a domain, a GitHub account.
2. **Fork this repo.**
3. **Set two GitHub Actions repository variables** (Settings → Secrets and
   variables → Actions → Variables): `REGISTRY` (e.g. `ghcr.io/you`) and
   `IMAGE_NAME` (e.g. `friendica-larpnet`). `.github/workflows/build.yml`
   reads both instead of a hardcoded registry — also set the
   `REGISTRY_USER`/`REGISTRY_PASSWORD` secrets it already expects.
4. **Edit the brand-config block** at the top of
   `view/theme/larpnet/theme.php` (`LARPNET_SCHEME_ACCENT_*` colors,
   `LARPNET_NAV_LABEL_*` top-nav labels) for your own branding.
5. **Decide on `addon/larpnet_wifi/`** — it's LARP-venue-WiFi-specific and
   optional; see its row in `CLAUDE.md` for the two-line removal if you
   don't need it.
6. **Decide on `view/lang/pl/strings.php`** — Polish translations for the
   custom nav labels, a known-limitation core-file patch; see its row in
   `CLAUDE.md`. Keep it, drop it (English works fine without it), or adapt
   it for a different language.
7. **Follow the existing release flow unchanged** — see "Building and
   releasing" above and `CLAUDE.md`'s "Building and deploying" section
   (`develop` → `larpnet` → `larpnet-test` → `release-*` tag).
8. **Minimal example deployment**, once you have a built image:

   ```yaml
   # compose.yaml
   services:
     friendica:
       image: ${REGISTRY}/${IMAGE_NAME}:latest
       environment:
         FRIENDICA_URL: https://your-domain.example
         FRIENDICA_ADMIN_MAIL: you@your-domain.example
         FRIENDICA_SITENAME: Your Community
         FRIENDICA_TZ: Europe/Warsaw
         MYSQL_HOST: db
         MYSQL_USER: friendica
         MYSQL_PASSWORD: ${MYSQL_PASSWORD}
         MYSQL_DATABASE: friendica
         REDIS_HOST: redis
       ports: ["8080:80"]
       depends_on: [db, redis]
     db:
       image: mariadb:latest
       environment:
         MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
         MYSQL_USER: friendica
         MYSQL_PASSWORD: ${MYSQL_PASSWORD}
         MYSQL_DATABASE: friendica
       volumes: ["mariadb_data:/var/lib/mysql"]
     redis:
       image: redis:alpine
   volumes:
     mariadb_data:
   ```

   ```bash
   # .env
   MYSQL_ROOT_PASSWORD=change-me
   MYSQL_PASSWORD=change-me
   ```

   This is deliberately minimal — a real deployment's own operational
   choices (staging environment, monitoring, backups, venue WiFi) are your
   own private config, not something this template provides. See
   `static/env.config.php` for the full list of `FRIENDICA_*` env vars.
9. **Chat (optional):** [`larpnet-chat-bridge`](https://github.com/zefir6/larpnet-chat-bridge)
   is open-source and pairs with `addon/larpnet_matrix/`'s Matrix/Synapse
   JWT login bridge, but it's documented as Larpnet's own tool (tied to
   this fork's specific `larpnet_matrix` JWT contract) rather than a
   drop-in for an unrelated Friendica deployment — read its README before
   adapting it.

Friendica - your open and free social network (LARPnet)
========================================================

Welcome to the free social web. Friendica is a platform for decentralised social communication linking to other independent social and corporate services.

Friendica connects you to a federated communications network of thousands of servers called the Fediverse.
Through various protocols you can interact with anyone on [Friendica]( https://friendi.ca), [Mastodon](https://joinmastodon.org), [Lemmy](https://join-lemmy.org/), [Diaspora](https://diasporafoundation.org), [Misskey](https://join.misskey.page), [Peertube](https://joinpeertube.org/), [Pixelfed](https://pixelfed.org/), [Pleroma](https://pleroma.social) and many more.
Receiving content from Tumblr, WordPress and RSS is also possible.
Friendica allows to import and mirror your content via add-ons such as ITTT and Buffer.
You can control the privacy scope of your content.

Being part of the Fediverse allows you to be free from data-harvesting corporations.
Enjoy open social communication, independent of any specific provider.

[Join Friendica](https://dir.friendica.social/servers) today or set up [your own Friendica instance](doc/en/admin/install.md).

### Friendica on desktop

![Frio theme in desktop browser](images/screenshots/friendica-2023-12-frio-desktop.png?raw=true "Frio theme in desktop browser")

### Friendica on mobile

<p float="left">
<img src="images/screenshots/friendica-2023-10-frio-mobile-timeline-dark-blue.png" width="370" alt="frio on mobile, dark color scheme">
<img src="images/screenshots/friendica-2023-10-frio-mobile-options-light-blue.png" width="370" alt="frio on mobile, light color scheme">
</p>

## Endorsements

- Friendica is listed on [![Awesome Humane Tech](images/humane-tech-badge.svg)](https://codeberg.org/teaserbot-labs/delightful-humane-design) in the [Fediverse category](https://codeberg.org/teaserbot-labs/delightful-humane-design#fediverse).

## Larpnet fork

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

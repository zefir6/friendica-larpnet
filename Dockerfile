FROM friendica:2026.08-rc-fpm AS base

# friendica:2026.08-rc-fpm ships from Docker Hub without any Friendica
# sources under /usr/src/friendica (only /usr/src/friendica/config/ exists -
# an upstream publishing bug affecting the whole 2026.08 pre-release wave,
# both -rc and -dev tags, both architectures; the PHP runtime/extensions in
# the image itself are fine). We build /usr/src/friendica ourselves from
# this repo instead of depending on upstream's image contents.
#
# NOTE: the friendica-addons branch below must be bumped in lockstep with
# the FROM tag's version above - it isn't derived automatically because
# build.sh/.github/workflows/build.yml parse the literal "FROM friendica:"
# line to derive the release tag.
FROM base AS builder
ENV COMPOSER_ALLOW_SUPERUSER=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip \
 && rm -rf /var/lib/apt/lists/*
COPY . /usr/src/friendica/
# Upstream keeps community addons in a separate repo; the official image
# normally supplies them, so pull the branch matching our core version and
# merge it in (our own larpnet_* addons, already copied above, are untouched).
RUN git clone --depth 1 --branch 2026.08-rc https://github.com/friendica/friendica-addons.git /tmp/friendica-addons \
 && cp -r /tmp/friendica-addons/. /usr/src/friendica/addon/ \
 && rm -rf /tmp/friendica-addons
RUN cd /usr/src/friendica && php bin/composer.phar install --no-dev --optimize-autoloader

FROM base

# Wrapper entrypoint: copies larpnet-patched files on every start,
# since the Friendica entrypoint only rsyncs on version upgrades.
COPY larpnet-entrypoint.sh /larpnet-entrypoint.sh
RUN chmod +x /larpnet-entrypoint.sh
ENTRYPOINT ["/larpnet-entrypoint.sh"]
CMD ["php-fpm"]

COPY --from=builder /usr/src/friendica /usr/src/friendica

# Custom theme
COPY view/theme/larpnet /usr/src/friendica/view/theme/larpnet

# Custom addons
COPY addon/larpnet_banner    /usr/src/friendica/addon/larpnet_banner
COPY addon/larpnet_calendar  /usr/src/friendica/addon/larpnet_calendar
COPY addon/larpnet_wifi      /usr/src/friendica/addon/larpnet_wifi
COPY addon/larpnet_fcm       /usr/src/friendica/addon/larpnet_fcm

# Core patches
COPY src/Protocol/ActivityPub/Transmitter.php     /usr/src/friendica/src/Protocol/ActivityPub/Transmitter.php
COPY src/Worker/Notifier.php                      /usr/src/friendica/src/Worker/Notifier.php
COPY src/Content/Item.php                         /usr/src/friendica/src/Content/Item.php
COPY src/Core/ACL.php                             /usr/src/friendica/src/Core/ACL.php
COPY src/Worker/NtfyPush.php                      /usr/src/friendica/src/Worker/NtfyPush.php
COPY src/Worker/NtfyPushMail.php                  /usr/src/friendica/src/Worker/NtfyPushMail.php
COPY src/Worker/FcmPush.php                       /usr/src/friendica/src/Worker/FcmPush.php
COPY src/Model/LarpnetPush.php                    /usr/src/friendica/src/Model/LarpnetPush.php
COPY src/Model/Mail.php                           /usr/src/friendica/src/Model/Mail.php
COPY src/Model/Subscription.php                   /usr/src/friendica/src/Model/Subscription.php
COPY src/Model/Item.php                           /usr/src/friendica/src/Model/Item.php
COPY src/Content/Conversation/PostTemplateBuilder.php /usr/src/friendica/src/Content/Conversation/PostTemplateBuilder.php
COPY src/Module/Item/Compose.php                  /usr/src/friendica/src/Module/Item/Compose.php
COPY src/Module/Item/Display.php                  /usr/src/friendica/src/Module/Item/Display.php
COPY src/Module/Post/Share.php                    /usr/src/friendica/src/Module/Post/Share.php
COPY src/Module/Privacy/PermissionTooltip.php     /usr/src/friendica/src/Module/Privacy/PermissionTooltip.php
COPY src/Module/Manifest.php                      /usr/src/friendica/src/Module/Manifest.php
COPY src/App/Page.php                             /usr/src/friendica/src/App/Page.php
COPY src/Module/FriendSuggest.php                 /usr/src/friendica/src/Module/FriendSuggest.php
COPY src/Module/Api/Mastodon/Accounts/UpdateCredentials.php /usr/src/friendica/src/Module/Api/Mastodon/Accounts/UpdateCredentials.php
COPY src/Module/Api/Mastodon/Conversations.php               /usr/src/friendica/src/Module/Api/Mastodon/Conversations.php
COPY src/Module/Api/Mastodon/Conversations/Read.php          /usr/src/friendica/src/Module/Api/Mastodon/Conversations/Read.php
COPY src/Factory/Api/Mastodon/Conversation.php               /usr/src/friendica/src/Factory/Api/Mastodon/Conversation.php
COPY src/Module/Api/Twitter/DirectMessagesEndpoint.php       /usr/src/friendica/src/Module/Api/Twitter/DirectMessagesEndpoint.php
COPY src/Module/Api/Mastodon/LarpnetPushConfig.php           /usr/src/friendica/src/Module/Api/Mastodon/LarpnetPushConfig.php
COPY src/Module/Api/Mastodon/Statuses.php                    /usr/src/friendica/src/Module/Api/Mastodon/Statuses.php
COPY src/Object/Api/Mastodon/Status.php                      /usr/src/friendica/src/Object/Api/Mastodon/Status.php
COPY static/routes.config.php                                /usr/src/friendica/static/routes.config.php
COPY view/lang/pl/strings.php                                /usr/src/friendica/view/lang/pl/strings.php
COPY src/Security/Authentication.php                         /usr/src/friendica/src/Security/Authentication.php

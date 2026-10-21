ARG PHP_IMAGE=php:8.4-fpm-trixie
ARG FRIENDICA_VERSION=2026.08-rc

# Builds the larpnet_matrix addon's own chat client (Preact + matrix-js-sdk,
# served same-origin by the addon itself -- see addon/larpnet_matrix/CLAUDE.md).
# Separate, self-contained stage: only this addon's client/ directory is
# needed as build context, so a change anywhere else in the repo doesn't
# invalidate npm install's cache layer.
FROM node:20-alpine AS matrix-client-builder
WORKDIR /build
COPY addon/larpnet_matrix/client/package.json addon/larpnet_matrix/client/package-lock.json ./
RUN npm ci
COPY addon/larpnet_matrix/client/ ./
RUN npm run build

# The friendica base layer (PHP runtime + extensions + upstream entrypoint)
# is built here from friendica/docker's 2026.08-rc/fpm Dockerfile (vendored
# at commit eb90b55, support files in docker/friendica-base/) instead of
# FROM friendica:<tag>-fpm, so a PHP security release only has to wait for
# docker-library's php image, not for Friendica's own image to be rebuilt
# on top of it. Pin PHP_IMAGE to an exact patch (e.g. php:8.4.27-fpm-trixie)
# to force a specific release.
#
# Upstream's friendica:2026.08-rc-fpm also shipped without any Friendica
# sources under /usr/src/friendica (a publishing bug in the 2026.08
# pre-release wave), so /usr/src/friendica is built from this repo below
# either way.
#
# build.sh/.github/workflows/build.yml parse the literal
# "ARG FRIENDICA_VERSION=" line to derive the release tag.
FROM ${PHP_IMAGE} AS base
ARG FRIENDICA_VERSION

# entrypoint.sh and cron.sh dependencies
RUN set -ex; \
    \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        rsync \
        bzip2 \
# For mail() support
        msmtp \
        tini \
    ;

ENV GOSU_VERSION=1.19
RUN set -eux; \
# save list of currently installed packages for later so we can clean up
	savedAptMark="$(apt-mark showmanual)"; \
	apt-get update; \
	apt-get install -y --no-install-recommends ca-certificates wget; \
	if ! command -v gpg; then \
		apt-get install -y --no-install-recommends gnupg2 dirmngr; \
	elif gpg --version | grep -q '^gpg (GnuPG) 1\.'; then \
# "This package provides support for HKPS keyservers." (GnuPG 1.x only)
		apt-get install -y --no-install-recommends gnupg-curl; \
	fi; \
	rm -rf /var/lib/apt/lists/*; \
	\
	dpkgArch="$(dpkg --print-architecture | awk -F- '{ print $NF }')"; \
	wget -O /usr/local/bin/gosu "https://github.com/tianon/gosu/releases/download/$GOSU_VERSION/gosu-$dpkgArch"; \
	wget -O /usr/local/bin/gosu.asc "https://github.com/tianon/gosu/releases/download/$GOSU_VERSION/gosu-$dpkgArch.asc"; \
	\
# verify the signature
	export GNUPGHOME="$(mktemp -d)"; \
	gpg --batch --keyserver hkps://keys.openpgp.org --recv-keys B42F6819007F00F88E364FD4036A9C25BF357DD4; \
	gpg --batch --verify /usr/local/bin/gosu.asc /usr/local/bin/gosu; \
	command -v gpgconf && gpgconf --kill all || :; \
	rm -rf "$GNUPGHOME" /usr/local/bin/gosu.asc; \
	\
# clean up fetch dependencies
	apt-mark auto '.*' > /dev/null; \
	[ -z "$savedAptMark" ] || apt-mark manual $savedAptMark; \
	apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false; \
	\
	chmod +x /usr/local/bin/gosu; \
# verify that the binary works
	gosu --version; \
	gosu nobody true

# install the PHP extensions we need
# see https://friendi.ca/resources/requirements/
RUN set -ex; \
    \
    savedAptMark="$(apt-mark showmanual)"; \
    \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        mariadb-client \
        bash \
        libpng-dev \
        libjpeg62-turbo-dev \
        libtool \
        libmagick++-dev \
        libmemcached-dev \
        zlib1g-dev \
        libssl-dev \
        libgraphicsmagick1-dev \
        libfreetype6-dev \
        libwebp-dev \
        librsvg2-2 \
        libzip-dev \
        libldap2-dev \
        libgmp-dev \
        libmagickcore-7.q16-10-extra \
        gettext \
    ; \
    \
    debMultiarch="$(dpkg-architecture --query DEB_BUILD_MULTIARCH)"; \
    \
    docker-php-ext-configure gd \
        --with-freetype \
        --with-jpeg \
        --with-webp \
    ; \
    docker-php-ext-configure ldap \
        --with-libdir=lib/$debMultiarch/ \
    ;\
    docker-php-ext-install -j "$(nproc)" \
        pdo_mysql \
        gd \
        exif \
        zip \
        opcache \
        ctype \
        pcntl \
        ldap \
        gmp \
        intl \
    ; \
    \
# pecl will claim success even if one install fails, so we need to perform each install separately
    pecl install apcu-5.1.28; \
    pecl install memcached-3.4.0; \
    pecl install redis-6.3.0 --configureoptions 'enable-redis-zstd="yes" enable-redis-lz4="yes"'; \
    pecl install imagick-3.8.1; \
    \
    docker-php-ext-enable \
        apcu \
        memcached \
        redis \
        imagick \
    ; \
    rm -r /tmp/pear; \
    \
# reset apt-mark's "manual" list so that "purge --auto-remove" will remove all build dependencies
    apt-mark auto '.*' > /dev/null; \
    apt-mark manual $savedAptMark; \
    ldd "$(php -r 'echo ini_get("extension_dir");')"/*.so \
        | awk '/=>/ { so = $(NF-1); if (index(so, "/usr/local/") == 1) { next }; gsub("^/(usr/)?", "", so); print so }' \
        | sort -u \
        | xargs -r dpkg-query -S \
        | cut -d: -f1 \
        | sort -u \
        | xargs -rt apt-mark manual; \
    \
    apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false; \
    rm -rf /var/lib/apt/lists/*

# set recommended PHP.ini settings
ENV PHP_MEMORY_LIMIT=512M
ENV PHP_UPLOAD_LIMIT=512M
RUN set -ex; \
    { \
        echo 'opcache.enable=1' ; \
        echo 'opcache.interned_strings_buffer=8'; \
        echo 'opcache.max_accelerated_files=10000'; \
        echo 'opcache.memory_consumption=128'; \
        echo 'opcache.save_comments=1'; \
        echo 'opcache.revalidte_freq=60'; \
        echo 'opcache.jit=tracing'; \
        echo 'opcache.jit_buffer_size=32M'; \
    } > /usr/local/etc/php/conf.d/opcache-recommended.ini; \
    \
    { \
        echo sendmail_path = "/usr/bin/msmtp -t"; \
    } > /usr/local/etc/php/conf.d/sendmail.ini; \
    \
    echo 'apc.enable_cli=1' >> /usr/local/etc/php/conf.d/docker-php-ext-apcu.ini; \
    \
    { \
        echo 'memory_limit=${PHP_MEMORY_LIMIT}'; \
        echo 'upload_max_filesize=${PHP_UPLOAD_LIMIT}'; \
        echo 'post_max_size=${PHP_UPLOAD_LIMIT}'; \
    } > /usr/local/etc/php/conf.d/friendica.ini; \
    ln -s /usr/local/etc/php/php.ini-production /usr/local/etc/php/php.ini

RUN set -ex; \
    echo access.format = '"%{REMOTE_ADDR}e - %u %t \"%m %r\" %s"' >> /usr/local/etc/php-fpm.d/docker.conf;

RUN set -ex; \
    mkdir -p -m 775 /var/www/data; \
    chown -R www-data:www-data /var/www/data

VOLUME /var/www/html
VOLUME /var/www/data

# 39 = LOG_PID | LOG_ODELAY | LOG_CONS | LOG_PERROR
ENV FRIENDICA_SYSLOG_FLAGS=39
ENV FRIENDICA_VERSION="${FRIENDICA_VERSION}"


RUN set -ex; \
    fetchDeps=" \
      gnupg \
    "; \
    apt-get update; \
    apt-get install -y --no-install-recommends $fetchDeps;

COPY docker/friendica-base/*.sh docker/friendica-base/upgrade.exclude /
COPY docker/friendica-base/config/* /usr/src/friendica/config/

ENTRYPOINT ["/entrypoint-dev.sh"]
CMD ["php-fpm"]

FROM base AS builder
ENV COMPOSER_ALLOW_SUPERUSER=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip \
 && rm -rf /var/lib/apt/lists/*
COPY . /usr/src/friendica/
# docker/friendica-base/ is only build input for the base stage above.
RUN rm -rf /usr/src/friendica/docker
# Upstream keeps community addons in a separate repo; the official image
# normally supplies them, so pull the branch matching our core version and
# merge it in (our own larpnet_* addons, already copied above, are untouched).
RUN git clone --depth 1 --branch "${FRIENDICA_VERSION}" https://github.com/friendica/friendica-addons.git /tmp/friendica-addons \
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

# Publicly-servable build identifier (see "Checking what's actually
# deployed" in CLAUDE.md) -- just a short git commit sha and a UTC build
# timestamp, nothing sensitive. GIT_SHA is passed by CI/build.sh; a local
# `docker build` with no --build-arg falls back to "unknown" rather than
# failing or guessing.
ARG GIT_SHA=unknown
RUN printf 'git_sha=%s\nbuilt_at=%s\n' "$GIT_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > /usr/src/friendica/build-version.txt

# Custom theme
COPY view/theme/larpnet /usr/src/friendica/view/theme/larpnet

# Custom addons
COPY addon/larpnet_banner    /usr/src/friendica/addon/larpnet_banner
COPY addon/larpnet_calendar  /usr/src/friendica/addon/larpnet_calendar
COPY addon/larpnet_wifi      /usr/src/friendica/addon/larpnet_wifi
COPY addon/larpnet_fcm       /usr/src/friendica/addon/larpnet_fcm
COPY addon/larpnet_apns      /usr/src/friendica/addon/larpnet_apns
COPY addon/larpnet_matrix    /usr/src/friendica/addon/larpnet_matrix
COPY --from=matrix-client-builder /build/dist /usr/src/friendica/addon/larpnet_matrix/client/dist

# Core patches
COPY src/Protocol/ActivityPub/Transmitter.php     /usr/src/friendica/src/Protocol/ActivityPub/Transmitter.php
COPY src/Worker/Notifier.php                      /usr/src/friendica/src/Worker/Notifier.php
COPY src/Content/Item.php                         /usr/src/friendica/src/Content/Item.php
COPY src/Core/ACL.php                             /usr/src/friendica/src/Core/ACL.php
COPY src/Worker/NtfyPush.php                      /usr/src/friendica/src/Worker/NtfyPush.php
COPY src/Worker/NtfyPushMail.php                  /usr/src/friendica/src/Worker/NtfyPushMail.php
COPY src/Worker/FcmPush.php                       /usr/src/friendica/src/Worker/FcmPush.php
COPY src/Worker/ApnsPush.php                      /usr/src/friendica/src/Worker/ApnsPush.php
COPY src/Model/LarpnetPush.php                    /usr/src/friendica/src/Model/LarpnetPush.php
COPY src/Model/Mail.php                           /usr/src/friendica/src/Model/Mail.php
COPY src/Model/Subscription.php                   /usr/src/friendica/src/Model/Subscription.php
COPY src/Model/Item.php                           /usr/src/friendica/src/Model/Item.php
COPY src/Model/Profile.php                        /usr/src/friendica/src/Model/Profile.php
COPY src/Module/Contact.php                       /usr/src/friendica/src/Module/Contact.php
COPY src/Module/BaseProfile.php                   /usr/src/friendica/src/Module/BaseProfile.php
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
COPY src/Module/Api/Mastodon/Timelines/PublicTimeline.php    /usr/src/friendica/src/Module/Api/Mastodon/Timelines/PublicTimeline.php
COPY src/Object/Api/Mastodon/Status.php                      /usr/src/friendica/src/Object/Api/Mastodon/Status.php
COPY static/routes.config.php                                /usr/src/friendica/static/routes.config.php
COPY view/lang/pl/strings.php                                /usr/src/friendica/view/lang/pl/strings.php
COPY src/Security/Authentication.php                         /usr/src/friendica/src/Security/Authentication.php
COPY src/Module/Conversation/Timeline.php                    /usr/src/friendica/src/Module/Conversation/Timeline.php

# Polls (local voting/creation only, not federated)
COPY static/dbstructure.config.php                           /usr/src/friendica/static/dbstructure.config.php
COPY mod/item.php                                            /usr/src/friendica/mod/item.php
COPY src/Model/Post/Question.php                             /usr/src/friendica/src/Model/Post/Question.php
COPY src/Model/Post/QuestionOptionVote.php                   /usr/src/friendica/src/Model/Post/QuestionOptionVote.php
COPY src/Factory/Api/Mastodon/Poll.php                       /usr/src/friendica/src/Factory/Api/Mastodon/Poll.php
COPY src/Module/Api/Mastodon/Polls/Votes.php                 /usr/src/friendica/src/Module/Api/Mastodon/Polls/Votes.php
COPY src/Object/Api/Mastodon/InstanceV2/Polls.php            /usr/src/friendica/src/Object/Api/Mastodon/InstanceV2/Polls.php
COPY src/Module/Api/Mastodon/InstanceV2.php                  /usr/src/friendica/src/Module/Api/Mastodon/InstanceV2.php
COPY src/Module/Api/Mastodon/Instance.php                    /usr/src/friendica/src/Module/Api/Mastodon/Instance.php
COPY src/Module/Item/Vote.php                                /usr/src/friendica/src/Module/Item/Vote.php
COPY src/Content/Conversation/StatusEditor.php               /usr/src/friendica/src/Content/Conversation/StatusEditor.php
COPY src/Module/Home.php                                     /usr/src/friendica/src/Module/Home.php
COPY view/templates/item/compose.tpl                         /usr/src/friendica/view/templates/item/compose.tpl
COPY view/templates/content/question.tpl                     /usr/src/friendica/view/templates/content/question.tpl

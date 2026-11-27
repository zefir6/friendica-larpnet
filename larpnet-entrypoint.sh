#!/bin/sh
set -e

# Runs as root (legacy) or as the compose `user:` (1006:1006). As non-root,
# everything below needs the html volume to belong to that user -- fail
# loudly with the fix instead of half-copying the patched files.
if [ "$(id -u)" -ne 0 ] && [ -d /var/www/html ] && [ ! -w /var/www/html ]; then
  echo "larpnet-entrypoint: /var/www/html is not writable by uid $(id -u)." >&2
  echo "  On the docker host: sudo chown -R $(id -u):$(id -g) html_data media_data" >&2
  exit 1
fi

# The Friendica entrypoint only rsyncs /usr/src/friendica → /var/www/html on
# version upgrades. For larpnet-only redeployments (same Friendica version),
# the sync is skipped and stale files stay on the volume. This wrapper
# unconditionally copies our patched files on every container start.
if [ -f /var/www/html/index.php ]; then
  # The whole image tree first, the same rsync the Friendica entrypoint does
  # on upgrades (upgrade.exclude keeps config/, storage, logs, .htaccess...).
  # Without it, composer dependency updates (vendor/), frontend assets
  # (view/asset/) and upstream addon updates never reached the volume: on
  # 2026-11-27 test still served guzzle 7.15.1 and DOMPurify 1.0.11 from it
  # although the image had the fixed versions. view/smarty3 is the compiled
  # template cache, not part of the image.
  if [ "$(id -u)" -eq 0 ]; then
    sync_owner="--chown=www-data:www-data"
  else
    sync_owner=""
  fi
  # shellcheck disable=SC2086
  rsync -rlD $sync_owner --delete --exclude-from=/upgrade.exclude \
    --exclude=/view/smarty3/ \
    /usr/src/friendica/ /var/www/html/

  # Kept as a second, explicit pass over the larpnet-patched files.
  for f in \
    src/Protocol/ActivityPub/Transmitter.php \
    src/Worker/Notifier.php \
    src/Content/Item.php \
    src/Core/ACL.php \
    src/Model/Item.php \
    src/Model/Photo.php \
    src/Model/Profile.php \
    src/Module/Contact.php \
    src/Module/BaseProfile.php \
    src/Content/Conversation/PostTemplateBuilder.php \
    src/Module/Item/Compose.php \
    src/Module/Item/Display.php \
    src/Module/Post/Share.php \
    src/Module/Privacy/PermissionTooltip.php \
    src/Module/Manifest.php \
    src/App/Page.php \
    src/Worker/NtfyPush.php \
    src/Worker/NtfyPushMail.php \
    src/Worker/FcmPush.php \
    src/Worker/ApnsPush.php \
    src/Model/LarpnetPush.php \
    src/Model/Mail.php \
    src/Model/Subscription.php \
    src/Module/FriendSuggest.php \
    src/Module/Api/Mastodon/Accounts/UpdateCredentials.php \
    src/Module/Api/Mastodon/Conversations.php \
    src/Module/Api/Mastodon/Conversations/Read.php \
    src/Factory/Api/Mastodon/Conversation.php \
    src/Module/Api/Twitter/DirectMessagesEndpoint.php \
    src/Module/Api/Mastodon/LarpnetPushConfig.php \
    src/Module/Api/Mastodon/Statuses.php \
    src/Module/Api/Mastodon/Timelines/PublicTimeline.php \
    src/Object/Api/Mastodon/Status.php \
    static/routes.config.php \
    view/lang/pl/strings.php \
    src/Security/Authentication.php \
    src/Module/Conversation/Timeline.php \
    static/dbstructure.config.php \
    mod/item.php \
    src/Model/Post/Question.php \
    src/Model/Post/QuestionOptionVote.php \
    src/Factory/Api/Mastodon/Poll.php \
    src/Module/Api/Mastodon/Polls/Votes.php \
    src/Object/Api/Mastodon/InstanceV2/Polls.php \
    src/Module/Api/Mastodon/InstanceV2.php \
    src/Module/Api/Mastodon/Instance.php \
    src/Module/Item/Vote.php \
    src/Content/Conversation/StatusEditor.php \
    src/Module/Home.php \
    src/Util/Network.php \
    src/Module/Register.php \
    src/Module/Admin/Site.php \
    view/templates/item/compose.tpl \
    view/templates/content/question.tpl \
    view/templates/widget/filter.tpl \
    addon/blockbot/blockbot.php \
    src/Util/LarpnetSeo.php \
    src/Module/LarpnetSitemap.php \
    src/Module/RobotsTxt.php \
    src/Module/Profile/Profile.php \
    src/Module/Profile/Conversations.php \
    build-version.txt
  do
    if [ -f "/usr/src/friendica/$f" ]; then
      install -D "/usr/src/friendica/$f" "/var/www/html/$f"
    else
      echo "larpnet-entrypoint: skipping missing patched file $f" >&2
    fi
  done

  for addon in larpnet_banner larpnet_calendar larpnet_wifi larpnet_fcm larpnet_apns larpnet_matrix; do
    cp -r "/usr/src/friendica/addon/${addon}" "/var/www/html/addon/"
  done

  cp -r "/usr/src/friendica/view/theme/larpnet" "/var/www/html/view/theme/"

  # Applies any pending schema changes (e.g. the post-question-option-vote
  # table added for polls) automatically on every start -- no-op if the
  # schema is already current. Run from the fresh build-time copy, not the
  # persistent volume, so it's always this image's version of the script.
  # Lives under bin/, not scripts/ -- .dockerignore excludes scripts/
  # entirely (it's host-side tooling like dbstructure-safe-update.sh,
  # never meant to be baked into the image), which silently dropped this
  # file from the build the first time it was added there: the container
  # crash-looped on every start because larpnet-entrypoint.sh's `set -e`
  # turned that missing-file error into a dead entrypoint, taking down
  # test.larpnet.pl. See bin/dbstructure-auto-update.sh for the
  # self-healing details.
  sh /usr/src/friendica/bin/dbstructure-auto-update.sh
fi

exec /entrypoint.sh "$@"

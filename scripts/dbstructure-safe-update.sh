#!/usr/bin/env bash
# dbstructure-safe-update.sh
# Self-healing wrapper around `bin/console.php dbstructure update`.
#
# Background: MySQL/MariaDB refuses to drop an index that's still backing a
# foreign key constraint ("Error 1553: Cannot drop index '...': needed in a
# foreign key constraint"). Friendica's schema differ can queue a DROP INDEX
# without dropping the FK constraint pinned to it first (this is what
# happened with our own addon/larpnet_fcm's `fcm-token`.`application-id`,
# now fixed at the source — see that addon's dbstructure_definition hook).
# Any other addon or a future core table can hit the same class of error
# and it stops the *entire* update, so this wrapper detects that specific
# failure signature, drops the offending FK constraint itself, and retries
# - looping until the update succeeds or a failure it doesn't recognize
# shows up.
#
# Note: `bin/console.php dbstructure update` always exits 0 (a Friendica
# console quirk, not specific to this script), so success/failure here is
# determined by scanning its output text, not its exit code.
#
# Deploy: run from the docker host after every upgrade, in place of calling
# `dbstructure update` directly:
#   ./scripts/dbstructure-safe-update.sh
#
# Configure COMPOSE_FILE / FRIENDICA_SERVICE / DB_SERVICE below to match your
# docker-compose.yml, or override them as env vars when invoking the script.

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/srv/docker/larpnet-test/compose.yml}"
FRIENDICA_SERVICE="${FRIENDICA_SERVICE:-friendica-test}"
DB_SERVICE="${DB_SERVICE:-db}"   # change to your DB service name, e.g. "mariadb" or "mysql"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-10}"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# Pull DB credentials straight out of Friendica's own config so nothing is
# hardcoded here. Falls back to DB_HOST/DB_USER/DB_PASS/DB_NAME env vars if
# that fails (e.g. non-standard console setup).
db_cfg() {
	compose exec -T "$FRIENDICA_SERVICE" php bin/console.php config database "$1" 2>/dev/null \
		| tail -n1 | sed -E "s/^database\.$1 => //"
}

DB_HOST="${DB_HOST:-$(db_cfg hostname || true)}"
DB_USER="${DB_USER:-$(db_cfg username || true)}"
DB_PASS="${DB_PASS:-$(db_cfg password || true)}"
DB_NAME="${DB_NAME:-$(db_cfg database || true)}"

if [[ -z "$DB_NAME" || -z "$DB_USER" ]]; then
	echo "Could not read DB credentials via 'console.php config database ...'." >&2
	echo "Set DB_HOST/DB_USER/DB_PASS/DB_NAME env vars and rerun." >&2
	exit 1
fi

mysql_exec() {
	compose exec -T -e MYSQL_PWD="$DB_PASS" "$DB_SERVICE" mysql -h"$DB_HOST" -u"$DB_USER" -N "$DB_NAME" -e "$1"
}

# Looks up the foreign key constraint backing a given table+index and drops
# it, so dbstructure update's DROP INDEX for that same index can succeed on
# retry (it will recreate whatever index/FK it still needs afterward).
resolve_index_conflict() {
	local table="$1" index="$2"
	echo "  Looking up the foreign key constraint backing \`$table\`.\`$index\`..."
	local constraint
	constraint="$(mysql_exec "
		SELECT DISTINCT k.CONSTRAINT_NAME
		FROM information_schema.KEY_COLUMN_USAGE k
		JOIN information_schema.STATISTICS s
		  ON s.TABLE_SCHEMA = k.TABLE_SCHEMA AND s.TABLE_NAME = k.TABLE_NAME AND s.COLUMN_NAME = k.COLUMN_NAME
		WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = '${table}' AND s.INDEX_NAME = '${index}'
		  AND k.REFERENCED_TABLE_NAME IS NOT NULL
		LIMIT 1;
	")"

	if [[ -z "$constraint" ]]; then
		echo "  Could not find a foreign key constraint backing that index. Not auto-fixable." >&2
		return 1
	fi

	echo "  Dropping foreign key \`$constraint\` on \`$table\` so the index can be replaced..."
	mysql_exec "ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${constraint}\`;"
	echo "  Dropped."
	return 0
}

attempt=1
while (( attempt <= MAX_ATTEMPTS )); do
	echo "== dbstructure update: attempt $attempt/$MAX_ATTEMPTS =="
	output="$(compose exec -T "$FRIENDICA_SERVICE" php bin/console.php dbstructure update 2>&1)"
	echo "$output"

	# Friendica's wrapper text around this is localized, but the raw driver
	# error text below is always in English (it comes straight from
	# MySQL/MariaDB, not through Friendica's translation layer), e.g.:
	#   ALTER IGNORE TABLE `fcm-token` DROP INDEX `application-id`;
	#   ...Cannot drop index 'application-id': needed in a foreign key constraint
	if ! grep -q "needed in a foreign key constraint" <<<"$output"; then
		echo "== No FK/index conflict detected — update finished =="
		exit 0
	fi

	table="$(grep -oE 'ALTER( IGNORE)? TABLE `[^`]+` DROP INDEX' <<<"$output" | tail -n1 | sed -E 's/.*TABLE `([^`]+)`.*/\1/')"
	index="$(grep -oE "Cannot drop index '[^']+'" <<<"$output" | tail -n1 | sed -E "s/.*'([^']+)'.*/\1/")"

	if [[ -z "$table" || -z "$index" ]]; then
		echo "Detected a 'needed in a foreign key constraint' error but couldn't parse the table/index from the output. Stopping." >&2
		exit 1
	fi

	echo "Detected MySQL error 1553 on \`$table\`.\`$index\` — attempting automatic repair."
	if ! resolve_index_conflict "$table" "$index"; then
		exit 1
	fi

	attempt=$(( attempt + 1 ))
done

echo "Gave up after $MAX_ATTEMPTS attempts — still failing. Investigate manually." >&2
exit 1

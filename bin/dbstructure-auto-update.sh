#!/bin/sh
# dbstructure-auto-update.sh
#
# Container-local counterpart to dbstructure-safe-update.sh: runs
# `bin/console.php dbstructure update` automatically on every container
# start (invoked by larpnet-entrypoint.sh), instead of requiring someone to
# SSH in and run the docker-host script by hand after every deploy.
#
# `dbstructure update` is run with --force: the plain command is gated
# behind system.build vs. the DB_UPDATE_VERSION constant in
# static/dbstructure.config.php, and only actually diffs/applies the
# schema when those differ. larpnet-only table additions (e.g.
# post-question-option-vote for polls) don't bump DB_UPDATE_VERSION --
# it's reserved for real upstream migrations -- so without --force the
# structure update silently never runs for them. The underlying diff/apply
# (Friendica\Database\DBStructure::performUpdate()) is idempotent and
# --force doesn't replay any version-numbered pre/post update functions
# when stored build == current build, so running it unconditionally on
# every start is still safe and cheap.
#
# Same self-healing as dbstructure-safe-update.sh for MySQL/MariaDB error
# 1553 ("Cannot drop index '...': needed in a foreign key constraint") --
# see that script's header for the full background. This version does the
# repair via PHP's PDO (bundled with Friendica's own DB dependency) instead
# of shelling out to a `mysql` CLI client and `docker compose exec`, since
# it runs from inside the already-started container, talking to the DB
# directly.
#
# scripts/dbstructure-safe-update.sh (the docker-host version) still exists
# for manual/local-dev use -- e.g. re-running by hand after editing
# static/dbstructure.config.php without restarting the container.

set -eu

MAX_ATTEMPTS="${DBSTRUCTURE_MAX_ATTEMPTS:-10}"
cd /var/www/html

db_cfg() {
	php bin/console.php config database "$1" 2>/dev/null | tail -n1 | sed -E "s/^database\\.$1 => //"
}

drop_fk() {
	table="$1"
	index="$2"
	host="$(db_cfg hostname)"
	user="$(db_cfg username)"
	pass="$(db_cfg password)"
	name="$(db_cfg database)"

	php -r '
		[$host, $user, $pass, $name, $table, $index] = array_slice($argv, 1);
		$pdo = new PDO("mysql:host=$host;dbname=$name;charset=utf8mb4", $user, $pass);
		$stmt = $pdo->prepare("
			SELECT DISTINCT k.CONSTRAINT_NAME
			FROM information_schema.KEY_COLUMN_USAGE k
			JOIN information_schema.STATISTICS s
			  ON s.TABLE_SCHEMA = k.TABLE_SCHEMA AND s.TABLE_NAME = k.TABLE_NAME AND s.COLUMN_NAME = k.COLUMN_NAME
			WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND s.INDEX_NAME = ?
			  AND k.REFERENCED_TABLE_NAME IS NOT NULL
			LIMIT 1
		");
		$stmt->execute([$table, $index]);
		$constraint = $stmt->fetchColumn();
		if (!$constraint) {
			fwrite(STDERR, "larpnet-entrypoint: could not find FK constraint backing $table.$index\n");
			exit(1);
		}
		fwrite(STDERR, "larpnet-entrypoint: dropping foreign key $constraint on $table\n");
		$pdo->exec("ALTER TABLE `$table` DROP FOREIGN KEY `$constraint`");
	' "$host" "$user" "$pass" "$name" "$table" "$index"
}

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
	echo "larpnet-entrypoint: dbstructure update attempt $attempt/$MAX_ATTEMPTS"
	set +e
	output="$(php bin/console.php dbstructure update --force 2>&1)"
	set -e
	echo "$output"

	if ! echo "$output" | grep -q "needed in a foreign key constraint"; then
		echo "larpnet-entrypoint: dbstructure update finished"
		exit 0
	fi

	table="$(echo "$output" | grep -oE "ALTER( IGNORE)? TABLE \`[^\`]+\` DROP INDEX" | tail -n1 | sed -E 's/.*TABLE `([^`]+)`.*/\1/')"
	index="$(echo "$output" | grep -oE "Cannot drop index '[^']+'" | tail -n1 | sed -E "s/.*'([^']+)'.*/\1/")"

	if [ -z "$table" ] || [ -z "$index" ]; then
		echo "larpnet-entrypoint: detected a FK/index conflict but couldn't parse the table/index, giving up" >&2
		exit 1
	fi

	echo "larpnet-entrypoint: MySQL error 1553 on \`$table\`.\`$index\` -- attempting automatic repair"
	drop_fk "$table" "$index"

	attempt=$((attempt + 1))
done

echo "larpnet-entrypoint: gave up after $MAX_ATTEMPTS attempts -- dbstructure update still failing, investigate manually" >&2
exit 1

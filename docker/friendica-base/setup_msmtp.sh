#!/bin/sh
set -eu

if [ -n "${SMTP_DOMAIN+x}" ] && [ -n "${SMTP+x}" ] && [ "${SMTP}" != "localhost" ]; then
  SITENAME="${FRIENDICA_SITENAME:-Friendica Social Network}"
  echo "Setup MSMTP for '$SITENAME' with '$SMTP' ..."

  smtp_from="${SMTP_FROM:=no-reply}"
  smtp_auth="${SMTP_AUTH:=on}"
  smtp_port="${SMTP_PORT:=587}"
  smtp_tls="${SMTP_TLS:=on}"

  if [ "$(id -u)" -eq 0 ]; then
    msmtprc=/etc/msmtprc
    aliases=/etc/aliases

    # Setup MSMTP
    usermod --comment "$(echo "$SITENAME" | tr -dc '[:print:]')" root
    usermod --comment "$(echo "$SITENAME" | tr -dc '[:print:]')" www-data
  else
    # larpnet: non-root (compose `user:`) can't write /etc. Keep the config
    # in the runtime dir instead -- owned by, and readable only by, the one
    # user PHP runs as -- and point PHP's sendmail_path at it via the
    # PHP_INI_SCAN_DIR directory the Dockerfile appends to conf.d.
    mkdir -p /tmp/larpnet/php-conf.d
    msmtprc=/tmp/larpnet/msmtprc
    aliases=/tmp/larpnet/msmtp-aliases
    echo "sendmail_path = \"/usr/bin/msmtp -C $msmtprc -t\"" >/tmp/larpnet/php-conf.d/msmtp.ini
  fi

  # add possible mail-senders
  {
    echo "www-data: $smtp_from@$SMTP_DOMAIN"
    echo "root: $smtp_from@$SMTP_DOMAIN"
  } >"$aliases"

  # Restrict new and existing files before writing any credentials.
  touch "$msmtprc"
  if [ "$(id -u)" -eq 0 ]; then
    # PHP invokes msmtp as www-data, so root-only permissions would break mail.
    chmod 0640 "$msmtprc"
    chown root:www-data "$msmtprc"
  else
    chmod 0600 "$msmtprc"
  fi

  # create msmtp settings
  {
    echo "account default"
    echo "host $SMTP"
    echo "port $smtp_port"
    echo "from \"$smtp_from@$SMTP_DOMAIN\""
    echo "tls_certcheck off" # No certcheck because of internal docker mail-hostnames
    echo "tls $smtp_tls"
    if [ -n "${SMTP_STARTTLS+x}" ]; then echo "tls_starttls $SMTP_STARTTLS"; elif [ $smtp_port = "465" ]; then echo "tls_starttls off"; else echo "tls_starttls on"; fi
    if [ -n "${SMTP_AUTH_USER+x}" ]; then echo "auth $smtp_auth"; fi
    if [ -n "${SMTP_AUTH_USER+x}" ]; then echo "user \"$SMTP_AUTH_USER\""; fi
    if [ -n "${SMTP_AUTH_PASS+x}" ]; then echo "password \"$SMTP_AUTH_PASS\""; fi
    echo "logfile -"
    echo "aliases $aliases"
  } >"$msmtprc"

  echo "Setup finished"
fi

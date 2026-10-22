#!/bin/bash
# Import: moneyman -> Actual, then link card bills, then write the per-bank health summary for the bot
# (tools/schedule), then prune old moneyman output. No arguments = every bank (the schedule); with moneyman
# companyIds = only those (on-demand refresh, tools/refresh). One import at a time; others wait for the lock.
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /opt/finance || exit 1
exec 9>/run/finance-import.lock && flock 9
R=/usr/local/sbin/finance-refresh; [ -x $R ] || R=true
$R started "$@"; trap '$R finished "$@"' EXIT
if [ $# -gt 0 ]; then
  # the config limited to these banks, passed through the environment so no other user can see it
  MONEYMAN_CONFIG=$($R config "$@") || exit 1; export MONEYMAN_CONFIG
  docker compose run --rm -e MONEYMAN_CONFIG moneyman >> /var/log/moneyman.log 2>&1
else
  docker compose run --rm moneyman >> /var/log/moneyman.log 2>&1
fi
echo "$(date -Is) moneyman${1:+ ($*)} exit=$?" >> /var/log/moneyman.status
(cd /opt/finance/card-bills && node index.mjs --apply) >> /var/log/moneyman.log 2>&1
echo "$(date -Is) card-bills exit=$?" >> /var/log/moneyman.status
/usr/local/sbin/finance-import-summary 2>> /var/log/moneyman.status || echo "$(date -Is) summary failed" >> /var/log/moneyman.status
find /opt/finance/output -name "*.json" -mtime +120 -delete

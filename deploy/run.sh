#!/bin/bash
# Scheduled import: moneyman -> Actual, then link card bills, then prune old moneyman output.
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /opt/finance || exit 1
docker compose run --rm moneyman >> /var/log/moneyman.log 2>&1
echo "$(date -Is) moneyman exit=$?" >> /var/log/moneyman.status
(cd /opt/finance/card-bills && node index.mjs --apply) >> /var/log/moneyman.log 2>&1
echo "$(date -Is) card-bills exit=$?" >> /var/log/moneyman.status
find /opt/finance/output -name "*.json" -mtime +120 -delete

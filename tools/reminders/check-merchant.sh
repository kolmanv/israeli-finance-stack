#!/bin/bash
# One-time TODO check from policy.md "Open TODOs" (local only).
# Usage: check-merchant.sh <run-year> <label> <imported_payee substring> <since YYYY-MM-DD>
# Writes the result to /var/log/finance-reminders.log and appends it to
# HANDOVER.md "Open items" so the next Claude session reports it.
set -u
YEAR="$1"; LABEL="$2"; MATCH="$3"; SINCE="$4"
[ "$(date +%Y)" = "$YEAR" ] || exit 0
cd /root/finance || exit 1
JSON=$(/usr/local/bin/actual --refresh query run --table transactions \
  --select "date,amount,account.name,imported_payee" \
  --filter "{\"imported_payee\":{\"\$like\":\"%${MATCH}%\"},\"date\":{\"\$gt\":\"${SINCE}\"}}" 2>&1)
MSG=$(echo "$JSON" | python3 -c '
import json,sys
label,since=sys.argv[1],sys.argv[2]
try: rows=json.load(sys.stdin)
except Exception: print(f"TODO check {label} FAILED: could not query Actual."); sys.exit()
if not rows: print(f"TODO check {label}: no charge after {since}, looks cancelled; remove it from Open TODOs in policy.md.")
else: print(f"TODO check {label}: STILL CHARGING after {since}: " + "; ".join("%s %.2f ILS %s" % (r["date"], -r["amount"]/100, r["account.name"]) for r in rows))
' "$LABEL" "$SINCE")
echo "$(date -Is) $MSG" >> /var/log/finance-reminders.log
[ "${DRY_RUN:-}" = 1 ] || echo "- **$(date +%F) reminder:** $MSG" >> /root/finance/HANDOVER.md

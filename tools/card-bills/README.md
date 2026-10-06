# card-bills

Israeli banks show a credit card's monthly bill as one line per card, often with the **same text for every card** of a card company. Actual's rules match on text, so they can't send each bill to the right card account. This tool does it deterministically, right after each moneyman import:

1. **By reference number**, when the bank embeds the card number in it (Mizrahi's Cal bills end with the card's last 4 digits).
2. **By sum**, comparing the bill amount with each card's charges for that billing date, taken from moneyman's JSON output (`localJson` storage must be enabled).
3. **Only card**: when a bank/company pair has a single card, every bill line goes to it.

A matched line becomes a transfer to the card account (Actual creates the payment on the card side) and gets a note: `card 1234 bill 2026-09 #card-bill`. Lines already converted are skipped, so re-running is safe. Lines matching several cards' combined total, or nothing, are reported and left for manual review.

## Setup

```bash
npm install                 # @actual-app/api, pinned to the actual-server version
cp config.example.json config.json   # map bank text -> card numbers -> Actual account names
node index.mjs              # dry-run report
node index.mjs --apply      # write
node index.mjs --since 2025-10-01   # backfill history (default: lookbackDays)
```

The Actual connection comes from `ACTUAL_SERVER_URL` / `ACTUAL_PASSWORD` / `ACTUAL_SYNC_ID`, or `~/.actualrc.json` (the same file `@actual-app/cli` uses). Card numbers are the `account` values moneyman reports for each card.

Keep `@actual-app/api` on the same version as `actual-server` and moneyman (see the version-coupling note in the design).

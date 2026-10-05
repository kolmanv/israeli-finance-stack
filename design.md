# Israeli Finance Stack

Pull transactions from Israeli banks and credit cards into a self-hosted budgeting app, and analyze them by talking to Claude.

**No custom code.** Every component is an existing open-source tool. This repo holds only these setup instructions. The configuration is a handful of small files, shown below.

**Priorities:** P0 is analysis ("where does our money go?"). P1 is envelope budgeting. Telegram comes later.

---

## Architecture

```
 Proxmox LXC "finance" ─────────────────────────────────────────────────┐
 │                                                                      │
 │  moneyman (cron, 2×/day)          actual-server :5006               │
 │  israeli-bank-scrapers ──import──► budget data (/data volume)  ◄──── browser (UI, reports)
 │                                        ▲                             │
 │  Claude Code ── @actual-app/cli ───────┘                             │
 │  (analysis; Telegram later via Channels)                             │
 └──────────────────────────────────────────────────────────────────────┘
```

| Component | What it does | Source |
|---|---|---|
| **Actual Budget** (`actual-server`) | The single source of truth: transactions, categories, rules, envelopes, reports, web UI | [actualbudget/actual](https://github.com/actualbudget/actual) (MIT) |
| **moneyman** | Logs into banks and cards with `israeli-bank-scrapers`, imports into Actual. Runs once and exits, so cron schedules it | [daniel-hauser/moneyman](https://github.com/daniel-hauser/moneyman) (MIT) |
| **`@actual-app/cli`** | Official CLI: query and edit the budget, JSON output. This is Claude Code's interface to the data | Part of Actual |
| **Claude Code** | Analysis by conversation. Later also the Telegram interface (Channels) | Anthropic |

### Key decisions

- **Actual is the only database.** It already stores transactions, rules and categories. Duplicates are skipped by `imported_id`. There's no Postgres. Raw scraper output is also kept as dated JSON files, for debugging only.
- **moneyman instead of a custom scraper service.** It already handles scheduling, config, a Chromium image, and export to Actual. It imports the *charged* amount, so installments (תשלומים) arrive as monthly charges. Pending transactions are skipped until they settle.
- **The CLI instead of custom tools or MCP.** Claude Code calls `actual …` directly. `actual-mcp` stays an option if a non-shell client needs it.
- **No push events.** Israeli banks offer no consumer APIs, so polling twice a day is the only option.

---

## Setup

### 1. Create the LXC (Proxmox)

- Template: Debian 12. Size: **2 vCPU, 4 GB RAM** (Chromium is memory-hungry), 16 GB disk. Unprivileged.
- Features: `pct set <CTID> --features nesting=1,keyctl=1` (required for Docker).
- Time zone: `Asia/Jerusalem`.
- Inside the LXC: `curl -fsSL https://get.docker.com | sh`

### 2. Files

```
/opt/finance/
├── docker-compose.yml
├── moneyman.json        # credentials, chmod 600, NEVER committed
└── output/              # raw scraper JSON (written by moneyman)
```

`docker-compose.yml`:

```yaml
services:
  actual-server:
    image: actualbudget/actual-server:26.10.0   # pin; see "Updates"
    restart: unless-stopped
    ports: ["5006:5006"]
    volumes: ["actual_data:/data"]

  moneyman:
    image: ghcr.io/daniel-hauser/moneyman:latest
    profiles: ["job"]                  # not started by `up`; run by cron
    environment:
      MONEYMAN_CONFIG_PATH: /config/moneyman.json
    volumes:
      - ./moneyman.json:/config/moneyman.json:ro
      - ./output:/app/output
    depends_on: [actual-server]

volumes:
  actual_data:
```

Start Actual: `cd /opt/finance && docker compose up -d`

### 3. Prepare Actual

1. Open `http://<lxc-ip>:5006`, set the server password, and create a budget.
2. Create **one account per bank account and per card**.
3. Note the **Sync ID** (Settings → Advanced) and each account's ID (`actual accounts list`, after step 6).

### 4. Connect banks and cards (`moneyman.json`)

moneyman logs in with the **same credentials you use on each website**.

```jsonc
{
  "accounts": [
    { "companyId": "hapoalim", "userCode": "…", "password": "…" },
    { "companyId": "isracard", "id": "…", "card6Digits": "…", "password": "…" }
  ],
  "storage": {
    "actual": {
      "serverUrl": "http://actual-server:5006",
      "password": "<actual server password>",
      "budgetId": "<Sync ID>",
      "accounts": { "<account / card number>": "<Actual account id>" }
    },
    "localJson": { "enabled": true, "path": "/app/output" }
  },
  "options": { "scraping": { "daysBack": 10 } }
}
```

| Login fields | Institutions (`companyId`) |
|---|---|
| `username`, `password` | `leumi`, `mizrahi`, `max`, `visaCal`, `otsarHahayal`, `union`, `beinleumi`, `massad`, `pagi` |
| `userCode`, `password` | `hapoalim` |
| `id`, `password`, `num` | `discount`, `mercantile` |
| `id`, `card6Digits`, `password` | `isracard`, `amex` |
| `username`, `nationalID`, `password` | `yahav` |

The `accounts` mapping keys are the account or card numbers as moneyman reports them. Do a first run with only `localJson` enabled, then read them from the output files.

### 5. First import, then schedule

```bash
# one-time history import: set "daysBack": 365, then
docker compose run --rm moneyman
# set daysBack back to 10, then add to crontab:
0 7,19 * * * cd /opt/finance && docker compose run --rm moneyman >> /var/log/moneyman.log 2>&1
```

The windows overlap on purpose. Actual skips anything it has already imported.

### 6. Claude Code

Inside the LXC, install Node 22+, Claude Code, and `npm i -g @actual-app/cli`. Create `~/.actualrc.json` (chmod 600) with `serverUrl`, `password`, `syncId`, and work from a folder whose `CLAUDE.md` says:

- Use the `actual` CLI (`actual query run`, `actual transactions list`, …) with JSON output.
- **Amounts are integer agorot:** −45000 = −₪450.00.
- Analysis is read-only. Show any change (category, rule, split) and get confirmation before running it.

### 7. Rules in Actual (one-time, in the UI)

- **Card bills → transfers.** The bank account shows one monthly line per card company (e.g. ישראכרט, מקס, כאל). Make a rule that sets that line's payee to the transfer to the matching card account. Otherwise every card purchase is counted twice.
- **Payee → category rules.** Build them up while categorizing. Actual also learns from manual categorization.

---

## Operations

- **Backups:** `vzdump` / PBS of the LXC covers everything, since `actual_data` is the only state. Actual can also export a `.zip` from the UI.
- **Scrape failures:** no notifications. Check `/var/log/moneyman.log`, or ask Claude "when was the last import per account?"
- **Updates:** moneyman bundles its own `@actual-app/api`. If its version doesn't match the server, imports fail with `out-of-sync-migrations`. Update both together, and pin `actual-server` to a version moneyman supports.
- **Security:** `moneyman.json` and `~/.actualrc.json` hold all secrets and stay on the LXC only (the repo is **public**). Keep port 5006 on the LAN only.

---

## Later

1. **Telegram via Claude Code Channels.** Official plugin, no code (research preview). Pair both spouses' Telegram accounts. Requires a long-running Claude Code session in the LXC.
2. **If Channels isn't enough** (inline Approve/Split buttons, a strict tool whitelist, pushes after each import): a small Claude Agent SDK bot, fed by moneyman's `webPost` destination.
3. **Hebrew UI** in Actual: not available (under 1% translated). Revisit later.

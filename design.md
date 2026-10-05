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
 │       │                                ▲                             │
 │       ▼ read-only bank logins          │                             │
 │   banks / card sites    Claude Code ── @actual-app/cli               │
 │                         (analysis; Telegram later via Channels)     │
 └──────────────────────────────────────────────────────────────────────┘
```

| Component | What it does | Source |
|---|---|---|
| **Actual Budget** (`actual-server`) | The single source of truth: transactions, categories, rules, envelopes, reports, web UI | [actualbudget/actual](https://github.com/actualbudget/actual) (MIT) |
| **moneyman** | Logs into banks and cards with `israeli-bank-scrapers`, imports into Actual. Runs once and exits, so cron schedules it | [daniel-hauser/moneyman](https://github.com/daniel-hauser/moneyman) (MIT) |
| **`@actual-app/cli`** | Official CLI: query and edit the budget, JSON output. This is Claude Code's interface to the data | Part of Actual |
| **Claude Code** | Analysis and rule upkeep by conversation. Later also the Telegram interface (Channels) | Anthropic |

### Key decisions

- **Actual is the only database.** It already stores transactions, rules and categories. Duplicates are skipped by `imported_id`. There's no Postgres. Raw scraper output is also kept as dated JSON files, for debugging only.
- **moneyman instead of a custom scraper service.** It already handles scheduling, config, a Chromium image, and export to Actual. It imports the *charged* amount, so installments (תשלומים) arrive as monthly charges. Pending transactions are skipped until they settle.
- **The CLI instead of custom tools or MCP.** Claude Code calls `actual …` directly. `actual-mcp` stays an option if a non-shell client needs it.
- **No push events.** Israeli banks offer no consumer APIs, so polling twice a day is the only option.
- **Rules do the categorizing, AI maintains the rules.** No AI runs at import time (see [Categorization](#categorization)).

### Scraping is fragile, by nature

`israeli-bank-scrapers` is **not an official API**. Every scraper except OneZero drives a real headless Chromium through the bank's website, then calls the site's internal endpoints. When a bank changes its site, that institution stops importing until the community ships a fix (typically days to weeks). The library had 35 releases in the 12 months up to Oct 2026.

How the design copes:
- **`daysBack: 30`:** every run re-reads a month, so imports catch up automatically after an outage of up to 30 days. Re-reads cost nothing because duplicates are skipped.
- **A failure check** (see [Operations](#operations)).

---

## Security

> **⚠️ The scraper logs in with whatever credentials you give it, and can do anything those credentials can do on the website.** The code only reads (checked by a scan of the `israeli-bank-scrapers` source, Oct 2026), but a malicious or buggy version could transfer money or take other actions. **Use read-only users only.**

All of our banks and card companies offer **read-only users** (הרשאת צפייה). Use them for every account in `moneyman.json`. This removes the most direct way to lose money: the bank itself refuses transfers for that user. It does **not** bound the damage of a compromised scraper (see below).

Beyond that, the stack trusts the open-source community (both projects are public, actively reviewed, and widely used in Israel), with a few cheap safeguards:

- **Pinned versions, validated before upgrading.** No `:latest`. Before moving to a new moneyman tag, confirm the scraper code is still read-only (see [Updates](#operations)).
- **Secrets only on the LXC.** `moneyman.json` and `~/.actualrc.json` are `chmod 600` and never committed (**the repo is public**).
- **No internet exposure.** Actual's web port stays on the LAN, with no port forwarding.
- **Bank alerts** (SMS/app) on logins and outgoing transfers.

**Accepted risk.** The code review doesn't cover moneyman's npm dependencies, and malicious code that runs on the server can do more than misuse the bank logins:
- leak the logins themselves, including national ID numbers and card digits (useful for phishing and identity fraud), and all transaction history;
- read other secrets in the LXC (the Actual password, Claude Code's credentials);
- attack other machines on the home network from the LXC.

Read-only users, an unprivileged LXC and pinned, reviewed versions make this unlikely, not impossible.

> **⚠️ No network firewall: the code check before every upgrade is the main safeguard.** Nothing restricts where the LXC can send data. **Never roll out a new moneyman version (or bump `israeli-bank-scrapers`) without first checking its code changes** (see [Updates](#operations)). Skipping the check means running unreviewed code that holds your bank logins.
>
> Future hardening, if wanted:
> - **moneyman domain firewall** (`options.security`: `blockByDefault` + per-scraper `ALLOW` rules). This is cheap, but it runs inside moneyman, so it stops a malicious dependency, not a malicious moneyman.
> - **Proxmox outgoing-traffic firewall** on the LXC (banks, registries, npm, Anthropic only; no LAN access). Nothing inside the LXC can bypass it.

Only moneyman touches the banks. Actual, the CLI, Claude Code and the future Telegram bot can only reach Actual's copy of the data.

---

## Setup

### 1. Create the LXC (Proxmox)

- Template: Debian 12. Size: **2 vCPU, 4 GB RAM** (Chromium is memory-hungry), 16 GB disk. Unprivileged.
- Features: `pct set <CTID> --features nesting=1,keyctl=1` (required for Docker).
- Time zone: `Asia/Jerusalem`.
- Inside the LXC: `curl -fsSL https://get.docker.com | sh`

Chromium runs headless inside moneyman's container (`--no-sandbox`, one browser at a time), so nothing else is needed in the LXC.

### 2. Files

```
/opt/finance/            # root-owned
├── docker-compose.yml
├── moneyman.json        # read-only bank credentials, chmod 600, NEVER committed
└── output/              # raw scraper JSON (written by moneyman)
```

`docker-compose.yml`:

```yaml
services:
  actual-server:
    image: actualbudget/actual-server:26.9.0     # must match moneyman's bundled API (see "Updates")
    restart: unless-stopped
    ports: ["5006:5006"]                       # host:container; host side can be any free port
    volumes: ["actual_data:/data"]

  moneyman:
    image: ghcr.io/daniel-hauser/moneyman:v2026.09.28.1   # ≥ this version (stable import ids)
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
2. Create **one on-budget account per bank account and per card** (both spouses' cards: a card left out leaves its bill counted as an expense).
3. Note the **Sync ID** (Settings → Advanced) and each account's ID (`actual accounts list`, after step 6).

### 4. Connect banks and cards (`moneyman.json`)

Create a **read-only user** at each bank and card company and use those credentials.

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
  "options": {
    "scraping": { "daysBack": 30 }
  }
}
```

| Login fields | Institutions (`companyId`) |
|---|---|
| `username`, `password` | `leumi`, `mizrahi`, `max`, `visaCal`, `otsarHahayal`, `union`, `beinleumi`, `massad`, `pagi` |
| `userCode`, `password` | `hapoalim` |
| `id`, `password`, `num` | `discount`, `mercantile` |
| `id`, `card6Digits`, `password` | `isracard`, `amex` |
| `username`, `nationalID`, `password` | `yahav` |

- **`accounts` mapping:** the keys are the account or card numbers as moneyman reports them. Do a first run with only `localJson` enabled and read them from the output files.

### 5. First import, then schedule

```bash
# one-time history import: set "daysBack": 365, then
docker compose run --rm moneyman
# set daysBack back to 30, then add to root's crontab:
0 7,19 * * * cd /opt/finance && docker compose run --rm moneyman >> /var/log/moneyman.log 2>&1; echo "$(date -Is) exit=$?" >> /var/log/moneyman.status
```

### 6. Claude Code

Install Node 22+, Claude Code, and `npm i -g @actual-app/cli`. Create `~/.actualrc.json` (chmod 600) with `serverUrl`, `password` and `syncId`, and work from a folder whose `CLAUDE.md` says:

- Use the `actual` CLI (`actual query run`, `actual transactions list`, …) with JSON output.
- **Amounts are integer agorot:** −45000 = −₪450.00.
- Analysis is read-only. Show any change (category, rule, split, payee merge) and get confirmation before running it.

---

## Categorization

### Card bills → transfers (one rule per card company)

The bank account shows one monthly line per card company, while the card account holds the individual purchases. Without a rule, every purchase counts twice.

```
IF   account = <bank account>  AND  imported payee contains "<bill text, e.g. ישראכרט>"
THEN payee = Transfer: <card account>
```

The purchases stay expenses (counted once), and the bill becomes a bank → card transfer: no envelope is touched and the bank balance stays correct. Don't use a "card payment" category (it would spend from an envelope) or a delete rule (it breaks bank reconciliation). If one bill covers several cards of the same company, transfer it to one of them. Per-card balances are then cosmetic only; the budget is correct.

### Everyday categorization: rules first, AI maintains them

Actual's rules match on imported payee, payee, amount, account, date and notes. They can set category, payee or notes, **create transfers**, and **split** by fixed amount, percentage, formula or remainder. Actual also **learns rules automatically** as you categorize. This covers recurring merchants, which is most of the volume.

Rules can't decide **Bit/PayBox** payments (the payee is the app), **mixed stores** (Super-Pharm, IKEA, AliExpress), **one-off splits**, or **new merchants**. For those, a weekly Claude Code session:

1. Lists uncategorized transactions, grouped, with a proposed category for each.
2. For anything that will repeat, proposes a **rule**. For merchant name variants (`SHUFERSAL DEAL 123` / `שופרסל דיל`), proposes a **payee merge** plus a rename rule.
3. After you approve, applies them (`actual rules create`, `actual payees merge`).
4. Occasionally audits the rules for conflicts or junk created by automatic learning.

The result is predictable, and the uncategorized pile shrinks each week.

---

## Operations

- **Backups:** `vzdump` / PBS of the LXC covers everything, since `actual_data` is the only state. Actual can also export a `.zip` from the UI.
- **Failure check (weekly):** `tail /var/log/moneyman.status`, or ask Claude "when was the last imported transaction per account?" An account that's silent for days means its scraper broke: update moneyman once a fix ships, and `daysBack: 30` backfills the gap.
- **Updates (Actual ↔ moneyman version coupling):** moneyman bundles its own `@actual-app/api`. If an Actual release changes the database layout (migrations), an older API fails with `out-of-sync-migrations`. moneyman lags Actual: its automatic API bumps have been closed unmerged since Feb 2026, and the version moves irregularly.
  - **Default:** upgrade `actual-server` only to the version matching moneyman's bundled API (check `@actual-app/api` in moneyman's `package-lock.json` for the release tag).
  - **Fallback if the lag hurts:** a two-line derived image, `FROM ghcr.io/daniel-hauser/moneyman:<tag>` + `RUN npm install @actual-app/api@<server version>`. (Open moneyman PR #921 would make this an env var.)
  - **Before any moneyman upgrade, validate that it's still read-only.** Ask Claude Code to review the diff from the current tag to the new one, in both moneyman and the `israeli-bank-scrapers` version it bundles (see `package-lock.json`). It should confirm the changes only touch login, navigation and reading data: no new form submissions, payment or transfer endpoints, or calls to unexpected domains. Upgrade only if it passes, and update the verified versions in [Security](#security).
  - **Status on 2026-10-05:** Actual v26.10.0 is out (with a migration). moneyman v2026.09.28.1 bundles API 26.9.0, so stay on **26.9.0**.

---

## Later

1. **Telegram via Claude Code Channels.** Official plugin, no code (research preview). Pair both spouses' Telegram accounts. Requires a long-running Claude Code session in the LXC.
2. **If Channels isn't enough** (inline Approve/Split buttons, a strict tool whitelist, pushes after each import): a small Claude Agent SDK bot, fed by moneyman's `webPost` destination.
3. **Hebrew UI** in Actual: not available (under 1% translated). Revisit later.

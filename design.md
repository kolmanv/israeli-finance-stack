# Israeli Finance Stack

Pull transactions from Israeli banks and credit cards into a self-hosted budgeting app, and analyze them by talking to Claude.

**No custom code.** Every component is an existing open-source tool. This repo is only these instructions; the configuration is the few small files shown below.

**Priorities:** P0 is analysis ("where does our money go?"). P1 is envelope budgeting. Telegram comes later.

---

## Architecture

```
 Proxmox LXC ───────────────────────────────────────────────────────────┐
 │  moneyman (cron 2×/day) ──import──► actual-server :5006  ◄──── browser (UI, reports)
 │       │ bank logins                      ▲                           │
 │       ▼                                  │                           │
 │  banks / card sites      Claude Code ── @actual-app/cli (Telegram later)
 └──────────────────────────────────────────────────────────────────────┘
```

| Component | Role | Source |
|---|---|---|
| **Actual Budget** | The single source of truth: transactions, categories, rules, envelopes, reports, web UI | [actualbudget/actual](https://github.com/actualbudget/actual) (MIT) |
| **moneyman** | Scrapes banks and cards with `israeli-bank-scrapers`, imports into Actual. Runs once and exits (cron) | [daniel-hauser/moneyman](https://github.com/daniel-hauser/moneyman) (MIT) |
| **`@actual-app/cli`** | Official CLI: query and edit the budget as JSON. This is Claude's interface to the data | Part of Actual |
| **Claude Code** | Analysis and rule upkeep by conversation. Later the Telegram interface (Channels) | Anthropic |

### Key decisions

- **Actual is the only database.** No Postgres. Duplicates are skipped by `imported_id`. Raw scraper output is also kept as JSON files, for debugging only.
- **moneyman, not a custom scraper.** It imports the *charged* amount, so installments (תשלומים) arrive as monthly charges. Pending transactions are skipped until they settle.
- **CLI, not custom tools.** Claude Code calls `actual …` directly. `actual-mcp` is an option for non-shell clients.
- **Polling only.** Banks offer no consumer APIs or events.
- **Rules categorize, AI maintains the rules.** No AI runs at import time ([Categorization](#categorization)).

### Scraping is fragile

`israeli-bank-scrapers` is **not an official API**. Every scraper except OneZero drives a headless Chromium through the bank's website and its internal endpoints. When a bank changes its site, that institution stops importing until the community ships a fix, typically days to weeks (35 releases in the year to Oct 2026). To cope:
- **`daysBack: 30`:** every run re-reads a month, so outages of up to 30 days backfill automatically. Duplicates are skipped.
- **A weekly failure check** ([Operations](#operations)).

---

## Security

> **⚠️ The scraper can do anything its login can do on the website.** The code only reads (full review of moneyman v2026.09.28.1 and its bundled `israeli-bank-scrapers` 6.12.1 on 2026-10-05; both rebuilt from source byte-identical to the image), but a malicious or buggy version could transfer money.
>
> **moneyman uses full-access logins.** Our banks offer read-only access (הרשאת צפייה) only by downgrading the account owner's own user, not as a separate user, so it isn't used. The limits that remain are the bank's own: an SMS/app code for transfers to new beneficiaries, transfer limits, and alerts. Check these settings at each bank. Where a separate read-only user exists (e.g. a card company, or a future bank option), prefer it: it only changes `moneyman.json`.

The stack trusts the open-source community (both projects are public, reviewed, and widely used in Israel), plus:
- **Pinned versions:** no `:latest`.
- **Secrets only on the LXC:** `moneyman.json` and `~/.actualrc.json` are `chmod 600` and never committed (**the repo is public**).
- **Remote access only through Cloudflare:** Actual is published as `actual.<your-domain>` by a Cloudflare Tunnel (the Home Assistant cloudflared add-on), behind **Cloudflare Access** with Google login and a policy that allows **two specific email addresses** (never "any Google account"). The policy covers the whole hostname, API paths included. No router port forwarding. Actual's own password stays as the second layer.
  - Cloudflare terminates TLS, so it sees budget data in transit.
  - **Don't enable Actual's end-to-end encryption:** moneyman's Actual import can't pass an encryption password, so imports would fail.
  - moneyman and the CLI use the internal address (`http://actual-server:5006` / `localhost`), never the tunnel.
  - The stricter alternative is no public hostname at all, with access over a VPN (Tailscale or WireGuard).
- **Bank alerts** (SMS/app) on logins and outgoing transfers.

**Accepted risk.** Malicious code on the server (the review doesn't cover moneyman's npm dependencies) could:
- use the full-access logins for anything the bank allows without an extra code (e.g. transfers within limits to existing beneficiaries, changing settings);
- leak the logins (national ID numbers, card digits: phishing and identity fraud) and all transaction history;
- read other secrets in the LXC (the Actual password, Claude Code's credentials);
- attack other machines on the home network.

The safeguards make this unlikely, not impossible.

> **⚠️ No network firewall: the code check before every upgrade is the main safeguard.** Nothing restricts where the LXC sends data. **Never roll out a new moneyman or `israeli-bank-scrapers` version without checking its code changes** ([Updates](#operations)).
>
> Future hardening, if wanted:
> - **moneyman domain firewall** (`options.security`: `blockByDefault` + per-scraper `ALLOW` rules; only active with `options.scraping.domainTracking: true`). Cheap, but it runs inside moneyman, so it stops a malicious dependency, not a malicious moneyman.
> - **Proxmox outgoing-traffic firewall** on the LXC (banks, registries, npm, Anthropic only; no LAN access). Nothing inside the LXC can bypass it.

Only moneyman touches the banks. Everything else reaches only Actual's data.

---

## Setup

### 1. LXC (Proxmox)

- Debian 13, unprivileged, **2 vCPU, 4 GB RAM** (Chromium), 16 GB disk, time zone `Asia/Jerusalem`.
- `pct set <CTID> --features nesting=1,keyctl=1` (needed for Docker).
- Inside: `curl -fsSL https://get.docker.com | sh`. Chromium ships in moneyman's image (headless, `--no-sandbox`, one browser at a time).

### 2. `/opt/finance/docker-compose.yml` (directory root-owned)

```yaml
services:
  actual-server:
    image: actualbudget/actual-server:26.9.0   # must match moneyman's bundled API (see Updates)
    restart: unless-stopped
    ports: ["5006:5006"]                       # host side can be any free port
    volumes: ["actual_data:/data"]             # all state lives here

  moneyman:
    image: ghcr.io/daniel-hauser/moneyman:v2026.09.28.1   # ≥ this (stable import ids)
    profiles: ["job"]                          # not started by `up`; run by cron
    environment:
      MONEYMAN_CONFIG_PATH: /config/moneyman.json
      MONEYMAN_UNSAFE_STDOUT: "true"             # else logs are written in the container and deleted
    volumes:
      - ./moneyman.json:/config/moneyman.json:ro   # chmod 600, never committed
      - ./output:/app/output                       # raw scraper JSON
    depends_on: [actual-server]

volumes: { actual_data: {} }
```

`cd /opt/finance && docker compose up -d`

### 3. Prepare Actual

1. Open `http://<lxc-ip>:5006`, set the server password, create a budget.
2. Create **one on-budget account per bank account and card**, including both spouses' cards (a card left out leaves its bill counted as an expense).
3. Note the **Sync ID** (Settings → Advanced) and the account IDs (`actual accounts list`, after step 6).

### 4. `/opt/finance/moneyman.json` (bank logins)

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
      // keys = account/card numbers as moneyman reports them: find them via a first run with only localJson
      "accounts": { "<account / card number>": "<Actual account id>" }
    },
    "localJson": { "enabled": true, "path": "/app/output" }
  },
  "options": {
    // transactionHashType: dedup by the bank's transaction id. Set before the first Actual import, never change
    "scraping": { "daysBack": 30, "transactionHashType": "moneyman" },
    "logging": { "getIpInfoUrl": false }   // skip the ipinfo.io public-IP lookup
  }
}
```

| Login fields | `companyId` |
|---|---|
| `username`, `password` | `leumi`, `mizrahi`, `max`, `visaCal`, `otsarHahayal`, `union`, `beinleumi`, `massad`, `pagi` |
| `userCode`, `password` | `hapoalim` |
| `id`, `password`, `num` | `discount`, `mercantile` |
| `id`, `card6Digits`, `password` | `isracard`, `amex` |
| `username`, `nationalID`, `password` | `yahav` |

### 5. First import, then schedule

```bash
# history: set "daysBack": 365, run once, then set it back to 30
docker compose run --rm moneyman
# root's crontab:
0 7,19 * * * cd /opt/finance && docker compose run --rm moneyman >> /var/log/moneyman.log 2>&1; echo "$(date -Is) exit=$?" >> /var/log/moneyman.status
```

### 6. Claude Code

Install Node 22+ (Debian 13 ships 20: use the official Node LTS tarball), Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`) and `npm i -g @actual-app/cli@<same version as actual-server>` (the CLI pins `@actual-app/api` exactly, so it has the same version coupling as moneyman). Create `~/.actualrc.json` (chmod 600) with `serverUrl`, `password` and `syncId`. Work from a folder whose `CLAUDE.md` says:
- Use the `actual` CLI (`actual query run`, `actual transactions list`, …) with JSON output.
- **Amounts are integer agorot:** −45000 = −₪450.00.
- Analysis is read-only. Show any change (category, rule, split, payee merge) and get confirmation first.

---

## Categorization

### Card bills → transfers (one rule per card company)

The bank shows one monthly bill line per card company, while the card account holds the purchases. Without a rule, every purchase counts twice.

```
IF   account = <bank account>  AND  imported payee contains "<bill text, e.g. ישראכרט>"
THEN payee = Transfer: <card account>
```

Purchases stay expenses (counted once). The bill becomes a bank → card transfer that touches no envelope and keeps the bank balance correct. Not a "card payment" category (it would spend from an envelope), and not a delete rule (it breaks bank reconciliation). If one bill covers several cards of the same company, transfer it to one of them: per-card balances become cosmetic, but the budget is correct.

### Everyday: rules first, AI maintains them

Actual's rules match on imported payee, payee, amount, account, date and notes. They can set category, payee or notes, **create transfers**, and **split** by amount, percentage, formula or remainder. Actual also **learns rules** as you categorize. That covers recurring merchants, which are most of the volume.

Rules can't decide **Bit/PayBox** payments (the payee is the app), **mixed stores** (Super-Pharm, IKEA, AliExpress), **one-off splits**, or **new merchants**. A weekly Claude Code session:
1. Lists uncategorized transactions, grouped, with proposed categories.
2. Proposes **rules** for anything recurring, and **payee merges** plus a rename rule for name variants (`SHUFERSAL DEAL 123` / `שופרסל דיל`).
3. Applies them after approval (`actual rules create`, `actual payees merge`).
4. Occasionally audits the rules for conflicts or junk from automatic learning.

The uncategorized pile shrinks each week.

---

## Operations

- **Backups:** `vzdump` / PBS of the LXC covers everything (`actual_data` is the only state). Actual can also export a `.zip`.
- **Failure check (weekly):** moneyman **always exits 0**, even when a scraper fails, so `moneyman.status` only proves the run completed. Check `grep -a 'error:' /var/log/moneyman.log` (needs `DEBUG=moneyman:*`), or ask Claude "last imported transaction per account?" An account silent for days means its scraper broke: update moneyman once a fix ships, and `daysBack` backfills. Leumi is flaky (page timeouts): a single failed run is normal.
- **Logs:** `/var/log/moneyman.log` (about 25k lines per full run with debug on), rotated daily by `/etc/logrotate.d/moneyman`, 14 days kept. They contain transaction details but no passwords; root-only.
- **Updates:**
  - **Check the code first (moneyman and `israeli-bank-scrapers`).** Have Claude Code review the diff from the current tag to the new one, in moneyman and in the scraper version it bundles (`package-lock.json`). Upgrade only if the changes touch nothing but login, navigation and reading: no new form submissions, payment or transfer endpoints, or unexpected domains.
  - **Version coupling.** moneyman bundles its own `@actual-app/api`. An Actual release with database migrations makes an older API fail with `out-of-sync-migrations`, and moneyman lags Actual (its API bumps have been closed unmerged since Feb 2026). So upgrade `actual-server` (and `@actual-app/cli`) only to the version moneyman bundles (`@actual-app/api` in its `package-lock.json`). If the lag hurts, use a two-line derived image: `FROM ghcr.io/daniel-hauser/moneyman:<tag>` + `RUN npm install @actual-app/api@<server version>` (open moneyman PR #921 would make this an env var).
  - **Status on 2026-10-05:** Actual v26.10.0 has a migration. moneyman v2026.09.28.1 bundles API 26.9.0, so stay on **26.9.0**.

---

## Later

1. **Telegram via Claude Code Channels.** Official plugin, no code (research preview). Pair both spouses' accounts. Needs a long-running Claude Code session in the LXC.
2. **If Channels isn't enough** (Approve/Split buttons, a strict tool whitelist, pushes after each import): a small Claude Agent SDK bot fed by moneyman's `webPost` destination.
3. **Hebrew UI** in Actual: under 1% translated. Contributing the translation (Weblate) and RTL fixes upstream would help every Hebrew-speaking user.
4. **A restricted assistant profile for Telegram:** read-only `actual` CLI access that can only propose changes; edits stay with the full (dev) profile and need confirmation.

```markdown
# System Design Specification: Israeli Financial Automation & Shared AI Assistant

## 1. High-Level System Architecture

The system provides a local-first, privacy-focused financial data pipeline that ingests transactions from Israeli banks and credit card companies, stores them in a relational database, syncs them to Actual Budget, and exposes a shared Telegram interface powered by an LLM with strict tool-calling boundaries.


```

```
                              [ HOME SERVER DOCKER NETWORK ]
                             ┌─────────────────────────────────┐
                             │  Container 1: actual-server     │
                             │  - Web UI (Chromebook / Mobile) │
                             │  - Local SQLite Budget Storage  │
                             └────────────────┬────────────────┘
                                              │ Local API (HTTP)
                                              ▼

```

┌──────────────────────┐  HTTPS  ┌─────────────────────────────────┐  SQL   ┌───────────────────────────┐
│ TELEGRAM GROUP CHAT  ├────────►│  Container 2: finance-bot-agent ├───────►│ Container 3: postgres     │
│ (You + Wife)         │◄────────┤  - Telegram Interface Daemon    │◄───────┤ - Raw Ingestion Archive   │
└──────────────────────┘         │  - LLM Function Calling Engine  │        │ - Vendor Rules Engine     │
│  - Strict API / Tool Sandbox    │        └─────────────▲─────────────┘
└────────────────┬────────────────┘                      │
│ External API                          │ Local Write
▼                                       │
┌─────────────────────────────────┐                      │
│ External LLM (Claude / Gemini)  │                      │
└─────────────────────────────────┘                      │
│
┌─────────────────────────────────┐                      │
│ Container 4: bank-ingestor      ├──────────────────────┘
│ - israeli-bank-scrapers (Cron)  │
└─────────────────────────────────┘

```

```

---

## 2. Component Breakdown

### Container 1: `actual-server`

* **Role:** Zero-based envelope budgeting engine and primary web UI.
* **Storage:** Local SQLite database file.
* **Interface:** Accessible via Chrome OS / browser as a Progressive Web App (PWA). Exposed on home network port `5006`.

### Container 2: `postgres`

* **Role:** Persistent relational archive for raw scraper outputs, transaction deduplication keys, vendor classification rules, and audit logs.
* **Storage:** Persistent Docker volume (`postgres_data`).

### Container 3: `bank-ingestor`

* **Role:** Automated daily ingestion daemon using `israeli-bank-scrapers`.
* **Execution:** Scheduled via internal cron daemon (runs daily at 03:00 AM).
* **Credentials:** Reads encrypted credentials from mounted local `.env` file.

### Container 4: `finance-bot-agent`

* **Role:** Telegram bot service connected to Claude/Gemini API via structured Function Calling.
* **Execution:** Long-polling daemon listening to the whitelisted Telegram Group ID.
* **Tools:** Bound to explicit API methods (no system shell execution).

---

## 3. Security, Isolation & Sandboxing Model

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SECURITY & ISOLATION MODEL                      │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Network Boundary: Containers reside on an isolated bridge network.   │
│ 2. DB Permissions: Non-admin 'bot_user' restricted to DML operations.   │
│ 3. Tool Sandboxing: LLM execution context limited to 4 specific code   │
│    functions (no shell, filesystem, or arbitrary network access).      │
│ 4. Access Control: Telegram message handler drops requests from        │
│    unlisted User/Chat IDs before passing context to LLM.               │
└────────────────────────────────────────────────────────────────────────┘

```

### Access Control Rules

1. **Telegram User Whitelist:** Hardcoded array of authorized User IDs (`ALLOWED_TELEGRAM_IDS=[12345678, 87654321]`). Unrecognized user messages are silently dropped.
2. **Database Permissions:** The bot connects to PostgreSQL as `bot_user` with permissions restricted to `SELECT`, `INSERT`, and `UPDATE` on specific tables (`raw_transactions`, `vendor_rules`). DDL operations (`DROP`, `ALTER`, `TRUNCATE`) are disabled.
3. **LLM Function Whitelist:** The LLM agent receives only four callable tool definitions:
* `query_envelope_balance(category_name: str)`
* `post_transaction(amount: float, payee: str, category: str, notes: str)`
* `split_transaction(parent_id: str, allocations: list)`
* `get_unlabeled_transactions()`



---

## 4. Proxmox LXC & Environment Provisioning

To maintain 100% portability across non-Proxmox users while providing native Proxmox advantages (snapshots, `vzdump` backups, resource limits), the entire stack is packaged into a single `docker-compose.yml` designed to run inside a single unprivileged Proxmox LXC container (or any standard Linux host).

```
┌─────────────────────────────────────────────────────────┐
│ PROXMOX VE HOST                                         │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ PROXMOX LXC CONTAINER (ID: 105 - "finance-stack") │  │
│  │  - Allocated: 2 Cores, 2GB RAM, 16GB Disk         │  │
│  │  - Proxmox Backup Server / vzdump enabled         │  │
│  │                                                   │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │ DOCKER ENGINE                               │  │  │
│  │  │  ├── actual-server                          │  │  │
│  │  │  ├── finance-postgres                       │  │  │
│  │  │  ├── bank-ingestor                          │  │  │
│  │  │  └── finance-bot-agent                      │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

```

### Proxmox LXC Setup Guidelines

* **Container Specifications:** Debian 12 or Ubuntu 24.04 CT template, 2 vCPUs, 2048 MB RAM, 16 GB Disk.
* **LXC Feature Flag:** Enable **Nesting** (`nesting=1`). Required for Docker-in-LXC execution.
* **Quick Provisioning Command (inside Proxmox node shell or LXC):**
```bash
# Inside LXC: Install Docker & Clone Stack
curl -fsSL [https://get.docker.com](https://get.docker.com) | sh
git clone [https://github.com/your-repo/israeli-finance-stack.git](https://github.com/your-repo/israeli-finance-stack.git)
cd israeli-finance-stack
chmod +x setup.sh && ./setup.sh

```



---

## 5. Turnkey Deployment Specification ("Under 1 Hour" Setup)

### Directory Structure

```
israeli-finance-stack/
├── docker-compose.yml
├── setup.sh
├── .env.example
├── init.sql
└── services/
    ├── ingestor/
    │   ├── Dockerfile
    │   └── scraper.js
    └── bot/
        ├── Dockerfile
        ├── bot.py
        └── tools.py

```

### `docker-compose.yml`

```yaml
version: '3.8'

networks:
  finance-net:
    driver: bridge

volumes:
  postgres_data:
  actual_data:

services:
  actual-server:
    image: actualbudget/actual-server:latest
    container_name: actual-server
    restart: unless-stopped
    ports:
      - "5006:5006"
    volumes:
      - actual_data:/data
    networks:
      - finance-net

  postgres:
    image: postgres:16-alpine
    container_name: finance-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-finances}
      POSTGRES_USER: ${POSTGRES_USER:-bot_user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    networks:
      - finance-net

  bank-ingestor:
    build: ./services/ingestor
    container_name: bank-ingestor
    restart: unless-stopped
    env_file: .env
    depends_on:
      - postgres
    networks:
      - finance-net

  finance-bot-agent:
    build: ./services/bot
    container_name: finance-bot-agent
    restart: unless-stopped
    env_file: .env
    depends_on:
      - postgres
      - actual-server
    networks:
      - finance-net

```

### `setup.sh` Workflow

```bash
#!/usr/bin/env bash
set -e

echo "=== Israeli Finance Stack Setup Wizard ==="

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

read -p "Enter Telegram Bot Token: " TELEGRAM_TOKEN
read -p "Enter Allowed Telegram User IDs (comma-separated): " TELEGRAM_USERS
read -p "Enter Claude / Gemini API Key: " LLM_KEY
read -p "Enter Postgres Password: " DB_PASS

sed -i "s|TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${TELEGRAM_TOKEN}|" .env
sed -i "s|ALLOWED_TELEGRAM_IDS=.*|ALLOWED_TELEGRAM_IDS=${TELEGRAM_USERS}|" .env
sed -i "s|LLM_API_KEY=.*|LLM_API_KEY=${LLM_KEY}|" .env
sed -i "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${DB_PASS}|" .env

echo "Building and starting Docker services..."
docker compose up -d --build

echo "=== Installation Complete! ==="
echo "Actual Budget UI available at: http://localhost:5006"

```

---

## 6. Database Schema Specification (`init.sql`)

```sql
CREATE TABLE IF NOT EXISTS raw_transactions (
    id VARCHAR(255) PRIMARY KEY,
    account_id VARCHAR(100) NOT NULL,
    date DATE NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    charged_amount NUMERIC(10, 2),
    payee_name VARCHAR(255) NOT NULL,
    memo TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    raw_payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendor_rules (
    id SERIAL PRIMARY KEY,
    pattern VARCHAR(255) NOT NULL,
    category_name VARCHAR(100) NOT NULL,
    default_split JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_raw_tx_date ON raw_transactions(date);
CREATE INDEX idx_raw_tx_status ON raw_transactions(status);

```

---

## 7. Shared Telegram Workflows

```
Sequence: Transaction Triage in Group Chat

Spouse A / B                   Telegram Bot Daemon              LLM API & Actual Server
     │                                 │                                 │
     │                                 ├──[ Scraper finds new charge ]──►│
     │                                 │   "IKEA - ₪450.00"              │
     │◄──[ Posts Inline Keyboard ]─────┤                                 │
     │    "Suggested: Home & Maint"    │                                 │
     │    [Approve] [Split] [Change]   │                                 │
     │                                 │                                 │
     ├───[ Taps "Split" ]─────────────►│                                 │
     │                                 ├───[ Prompt: How to split? ]────►│
     │                                 │                                 │
     ├───"300 Furniture, 150 House"───►│                                 │
     │                                 ├───[ Calls split_transaction() ]►│
     │                                 │                                 │
     │◄──[ Confirmation Message ]──────┼◄──[ Split recorded in Actual ]──┤
     │    "✅ Recorded in Actual"       │                                 │

```

---

## 8. Implementation Effort Estimation

| Phase | Tasks | Estimated Hours |
| --- | --- | --- |
| **Phase 1: Infrastructure** | Docker Compose setup, Postgres initialization, Actual Budget container deployment, Proxmox LXC testing. | 3–4 hours |
| **Phase 2: Ingestion & Rules** | Node.js scraper service with `israeli-bank-scrapers`, Postgres persistence, deduplication logic. | 3–4 hours |
| **Phase 3: AI Agent & Bot** | Python Telegram daemon, whitelisting, LLM function calling, Actual API wrapper integration. | 4–6 hours |
| **Phase 4: Installer & Package** | `setup.sh` script, `.env.example` templates, initial database schema migrations, and end-to-end deployment verification. | 2–4 hours |
| **TOTAL** | **Complete turnkey deployment package** | **12–18 hours** |

```

```

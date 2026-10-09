# Tools

| Path | What it does |
|---|---|
| `card-bills/` | Links credit-card bill lines in bank accounts to the right card account (see its README). |
| `reminders/check-merchant.sh` | One-time check, run from cron, that a merchant stopped charging (e.g. after cancelling a subscription). Writes the result to `/var/log/finance-reminders.log` and to the assistant's handover file. `cron.example` shows the schedule format. |
| `telegram/start-bot.sh` | Starts the Claude Code Telegram channel session in a detached tmux session. `bot-settings.json` enables the Telegram plugin only for that session, so other Claude sessions don't take over the bot. |

Deployment pieces are in `../deploy/`: `run.sh` (scheduled import: moneyman -> Actual, then card-bills, then prune old moneyman output), `cron-moneyman` and `logrotate-moneyman`.

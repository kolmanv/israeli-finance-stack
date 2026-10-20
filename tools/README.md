# Tools

| Path | What it does |
|---|---|
| `card-bills/` | Links credit-card bill lines in bank accounts to the right card account (see its README). |
| `reminders/check-merchant.sh` | One-time check, run from cron, that a merchant stopped charging (e.g. after cancelling a subscription). Runs as the bot user. Writes the result to `/var/log/finance-reminders.log` (owned by the bot user) and to the assistant's handover file. `cron.example` shows the schedule format. |
| `telegram/start-bot.sh` | Starts the Claude Code Telegram channel session in a detached tmux session, as the unprivileged bot user (see design.md, step 7). `bot-settings.json` enables the Telegram plugin only for that session, so other Claude sessions don't take over the bot. `cron-reboot.example` starts it after a reboot (start-bot.sh sets the PATH: the plugin is a [Bun](https://bun.sh) program). |

Deployment pieces are in `../deploy/`: `run.sh` (scheduled import: moneyman -> Actual, then card-bills, then prune old moneyman output), `cron-moneyman` and `logrotate-moneyman`.

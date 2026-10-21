#!/bin/bash
# Starts the Telegram bot session (tmux "finance") as the unprivileged bot user.
# The plugin is disabled at user scope so ordinary Claude sessions don't take over the bot;
# this session enables it via --settings.
# --continue resumes the previous conversation, so restarts (updates, reboots) keep the context.
export ENABLE_CLAUDEAI_MCP_SERVERS=false  # no claude.ai account connectors (Drive, Gmail) in the bot
export PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin  # the plugin needs bun
tmux has-session -t finance 2>/dev/null && { echo "already running"; exit 0; }
tmux new-session -d -s finance -x 200 -y 50 -c "$HOME/finance" \
  "claude --continue --permission-mode auto --settings $HOME/finance/bot/bot-settings.json --channels plugin:telegram@claude-plugins-official"

#!/bin/bash
# Starts the Telegram bot session (tmux "kaspi") as the unprivileged bot user.
# The plugin is disabled at user scope so ordinary Claude sessions don't take over the bot;
# this session enables it via --settings.
# --continue resumes the previous conversation, so restarts (updates, reboots) keep the context.
export ENABLE_CLAUDEAI_MCP_SERVERS=false  # no claude.ai account connectors in the bot; MCP servers come from $MCP
export PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin  # the plugin needs bun
MCP=$HOME/.config/kaspi/mcp.json  # optional (Google Drive/Sheets, WhatsApp): see mcp.example.json
tmux has-session -t kaspi 2>/dev/null && { echo "already running"; exit 0; }
mkdir -p -m 700 /tmp/tmux-$(id -u)  # cron starts it without a login session
[ -f "$MCP" ] && m="--mcp-config $MCP"
tmux new-session -d -s kaspi -x 200 -y 50 -c "$HOME/kaspi" \
  "claude --continue --permission-mode auto --settings $HOME/kaspi/bot/bot-settings.json $m --channels plugin:telegram@claude-plugins-official"

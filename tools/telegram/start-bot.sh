#!/bin/bash
# Starts the Telegram bot session (tmux "finance"). The plugin is disabled at user scope
# so ordinary Claude sessions don't take over the bot; this session enables it via --settings.
tmux has-session -t finance 2>/dev/null && { echo "already running"; exit 0; }
mkdir -p -m 700 /tmp/tmux-0
tmux new-session -d -s finance -x 200 -y 50 -c /root/finance \
  'claude --permission-mode auto --settings /root/finance/bot/bot-settings.json --channels plugin:telegram@claude-plugins-official'

#!/usr/bin/env bash
# Start the bot with append-mode logging so logs survive restarts.
# Usage: bash start.sh
# Logs: ./data/bot.log (append, never truncated)

set -e
cd "$(dirname "$0")"

mkdir -p data

LOG_FILE="$(pwd)/data/bot.log"

echo "Starting bot — logging to $LOG_FILE"
exec node src/index.js >> "$LOG_FILE" 2>&1

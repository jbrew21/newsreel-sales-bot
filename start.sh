#!/bin/bash
# Start Newsreel Sales Bot
# Usage: bash start.sh

cd "$(dirname "$0")"

# Load agent IDs
if [ -f "../agent-ids.env" ]; then
  source ../agent-ids.env
fi

# Load secrets if available (local only - Render uses env vars)
if [ -f ".secrets" ]; then
  source .secrets
fi

# Check required env vars
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "ERROR: Set TELEGRAM_BOT_TOKEN first:"
  echo "  export TELEGRAM_BOT_TOKEN='your-token-from-botfather'"
  exit 1
fi

if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "ERROR: Set ANTHROPIC_API_KEY first:"
  echo "  export ANTHROPIC_API_KEY='your-key'"
  exit 1
fi

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

export TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-6535760391}"

echo "Starting Newsreel Sales Bot v2..."
echo "Talk to it in Telegram!"
node bot-v2.js

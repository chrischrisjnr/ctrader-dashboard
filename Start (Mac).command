#!/bin/bash
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed yet. Opening the download page..."
  echo "Install the \"LTS\" version, then double-click this file again."
  open "https://nodejs.org/en/download"
  read -r -p "Press Enter to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First start: installing, this takes about a minute..."
  if ! npm install --omit=dev --no-audit --no-fund; then
    echo "Installation failed. Check your internet connection and try again."
    read -r -p "Press Enter to close."
    exit 1
  fi
fi

echo
echo "The dashboard will open in your browser: http://127.0.0.1:3000"
echo "Keep this window open while your bots run. Close it to stop the dashboard."
echo
(sleep 3 && open "http://127.0.0.1:3000") &
node server/index.js
read -r -p "Press Enter to close."

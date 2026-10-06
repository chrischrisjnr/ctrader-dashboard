#!/bin/bash
# Starts the dashboard so your iPhone / iPad on the same Wi-Fi (or Tailscale) can open it too.
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

# Other devices must log in, so a password is required. Asked once, then remembered.
if [ ! -f phone-access.env ]; then
  echo "Choose a password for opening the dashboard on your phone and iPad."
  echo "(at least 8 letters and numbers; you'll type it once on each device)"
  while true; do
    read -r -s -p "Password: " pw; echo
    if [[ ! "$pw" =~ ^[A-Za-z0-9]{8,}$ ]]; then
      echo "Use at least 8 letters and numbers only. Try again."
      continue
    fi
    read -r -s -p "Same password again: " pw2; echo
    [ "$pw" = "$pw2" ] && break
    echo "The two passwords didn't match. Try again."
  done
  umask 077
  printf 'DASHBOARD_PASSWORD=%s\n' "$pw" > phone-access.env
  echo "Saved. (To change it later, delete the file phone-access.env.)"
fi
set -a
. ./phone-access.env
set +a
export HOST=0.0.0.0

echo
echo "Keep this window open. Close it to stop the dashboard."
echo "If your Mac asks whether \"node\" may accept incoming network connections, click Allow."
echo
(sleep 3 && open "http://127.0.0.1:3000") &
# caffeinate stops the Mac from going to sleep while the dashboard runs.
caffeinate -i node server/index.js
read -r -p "Press Enter to close."

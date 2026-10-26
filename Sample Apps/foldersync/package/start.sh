#!/bin/bash
# Starts FolderSync: starts the token server if it isn't running, opens the
# app, and stops the token server when the app quits. The app secret goes to
# the token server over stdin and is never saved. FOLDERSYNC_PORT sets the
# token server's port (default 8787).
set -euo pipefail
cd "$(dirname "$0")"

# Removes the flag macOS puts on downloaded files. The app and token server
# aren't notarized, so macOS won't run them while it's set.
xattr -dr com.apple.quarantine FolderSync.app tokenserver start.sh

port="${FOLDERSYNC_PORT:-8787}"
if ! [[ "$port" =~ ^[0-9]+$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
  echo "FOLDERSYNC_PORT must be a port number from 1 to 65535, not \"$port\"." >&2
  exit 1
fi
url="http://127.0.0.1:$port"
home_dir="${FOLDERSYNC_HOME:-$HOME/.foldersync}"
key_file="$home_dir/tokenserver/app_key"

running() {
  curl -fsS --max-time 1 "$url/health" >/dev/null 2>&1
}

if running; then
  echo "Using the token server that's already running at $url."
else
  saved=$(cat "$key_file" 2>/dev/null || true)
  # Shows only the start of the saved key, so it stays out of screen recordings.
  read -rp "App key${saved:+ [${saved:0:4}••••]}: " app_key
  app_key="${app_key:-$saved}"
  read -rsp "App secret (hidden): " secret
  echo
  if [ -z "$app_key" ] || [ -z "$secret" ]; then
    echo "The app key and app secret are required." >&2
    exit 1
  fi
  mkdir -p "$home_dir/tokenserver"
  chmod 700 "$home_dir" "$home_dir/tokenserver"
  printf '%s\n' "$app_key" > "$key_file"
  chmod 600 "$key_file"

  printf '%s\n' "$secret" | ./tokenserver serve -app-key "$app_key" -app-secret-stdin -listen "127.0.0.1:$port" &
  server=$!
  unset secret
  # Same lifecycle as the app: stop the token server when this script exits.
  trap 'kill "$server" 2>/dev/null || true' EXIT
  # Longer than the token server's own 15-second check with Dropbox.
  for _ in $(seq 1 200); do
    running && break
    if ! kill -0 "$server" 2>/dev/null; then
      echo "The token server stopped. See its message above." >&2
      exit 1
    fi
    sleep 0.15
  done
  if ! running; then
    echo "The token server didn't start within 30 seconds." >&2
    exit 1
  fi
fi

# Waits until FolderSync quits.
open -W --env FOLDERSYNC_PORT="$port" FolderSync.app

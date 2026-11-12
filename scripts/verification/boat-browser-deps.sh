#!/usr/bin/env bash
set -euo pipefail

# Chromium and Electron use these Ubuntu 24.04 libraries. A prepared image
# checks package state without refreshing apt metadata or contacting a mirror.
packages=(
  xvfb xauth fonts-liberation
  libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64
  libcairo2 libcups2t64 libdbus-1-3 libdrm2 libexpat1 libgbm1
  libglib2.0-0t64 libgtk-3-0t64 libnotify4 libnspr4 libnss3 libpango-1.0-0
  libsecret-1-0 libuuid1 libxss1
  libx11-6 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6
  libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1 libxtst6
)
missing=()
for package in "${packages[@]}"; do
  if [[ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]]; then
    missing+=("$package")
  fi
done
if ((${#missing[@]})); then
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
fi
command -v xvfb-run >/dev/null

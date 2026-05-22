#!/usr/bin/env bash
# Rasterize dohc brand SVGs into social-ready PNGs using headless Chrome.
# Run from the social-assets/ directory.
set -euo pipefail
CHROME=/usr/bin/google-chrome
DIR="$(cd "$(dirname "$0")" && pwd)"

render() {  # render <html> <out.png> <w> <h>
  "$CHROME" --headless --disable-gpu --no-sandbox \
    --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 \
    --screenshot="$DIR/$2" --window-size="$3,$4" \
    "file://$DIR/$1" >/dev/null 2>&1
}

render avatar-light.html  dohc-avatar-light.png  1024 1024
render avatar-dark.html   dohc-avatar-dark.png   1024 1024
render mark-graphite.html dohc-mark-graphite.png 1024 1024
render mark-bone.html     dohc-mark-bone.png     1024 1024
render banner.html        dohc-social-banner.png 1200 630
echo "done"

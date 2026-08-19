#!/usr/bin/env bash
# deploy/deploySite.sh — publish the tamagotchi to youraipet.xyz.
#
# Run from the repo root on the laptop, not on the server: unlike the other
# projects on that box there is no checkout there and nothing to build there.
# The site is two files, so a push over rsync IS the deploy.
#
#   1. Build frontend/ai_pet.py from contracts/ai_pet.py. It is gitignored and
#      generated on purpose — a committed copy is how a stale contract ends up
#      shipping beside a newer page. Same ~52 KB Bradbury ceiling check the
#      Pages workflow does, for the same reason: over it, deploys fail at gas
#      estimation, and the player only finds out after paying.
#   2. Refuse a relative <script src>/<link href>. Harmless at a domain root,
#      fatal under a path prefix — kept here so both publishing paths agree.
#   3. rsync the two files to /srv/youraipet/web.
#   4. Sync deploy/youraipet.caddy into /etc/caddy/sites.d/ if it drifted, then
#      `caddy validate` the WHOLE config before reloading. That box serves four
#      other projects; a reload on a broken config would take them all down.
#   5. Health check against the public name — proves TLS, Caddy and the files
#      end to end, not just that rsync exited 0.
#
# Idempotent. Re-running costs one rsync of two unchanged files.

set -euo pipefail

HOST=root@138.201.92.157
ROOT=/srv/youraipet/web
CADDY_SRC=deploy/youraipet.caddy
CADDY_DST=/etc/caddy/sites.d/youraipet.caddy
SITE=https://youraipet.xyz

cd "$(dirname "$0")/.."

echo "==> building the contract the page deploys"
npm run --silent build:site
bytes=$(wc -c < frontend/ai_pet.py)
echo "    artifact ${bytes} bytes"
if [ "$bytes" -gt 53248 ]; then
	echo "!!! ${bytes} bytes, over the ~52 KB Bradbury deploy ceiling" >&2
	exit 1
fi

echo "==> checking the page is self-contained"
if grep -nE '<(script|link)[^>]+(src|href)="[^"h#/]' frontend/index.html; then
	echo "!!! relative asset reference" >&2
	exit 1
fi

echo "==> uploading"
ssh "$HOST" "mkdir -p $ROOT"
# No --chmod: macOS ships openrsync, which does not have it. -a preserves the
# local 644, which is what the caddy user needs to read them anyway.
rsync -az --delete frontend/index.html frontend/ai_pet.py "$HOST:$ROOT/"
# -a preserves the sender's uid, and the laptop's 501 is nobody on that box.
# Harmless — 644 is world-readable and caddy only needs to read — but a file
# owned by a uid with no passwd entry is the kind of thing that reads as a
# mistake later. Normalise it.
ssh "$HOST" "chown -R root:root $ROOT"

echo "==> syncing the caddy site file"
if ! ssh "$HOST" "cat $CADDY_DST 2>/dev/null" | diff -q - "$CADDY_SRC" >/dev/null 2>&1; then
	scp -q "$CADDY_SRC" "$HOST:$CADDY_DST"
	ssh "$HOST" "caddy validate --config /etc/caddy/Caddyfile >/dev/null && systemctl reload caddy"
	echo "    installed and reloaded"
else
	echo "    unchanged"
fi

echo "==> health check"
code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/")
type=$(curl -sI "$SITE/ai_pet.py" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
echo "    $SITE/ -> $code"
echo "    $SITE/ai_pet.py -> $type"
[ "$code" = "200" ] || { echo "!!! page did not answer 200" >&2; exit 1; }
case "$type" in text/plain*) ;; *) echo "!!! contract is not served as text/plain" >&2; exit 1 ;; esac

echo "==> done"

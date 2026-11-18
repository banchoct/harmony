#!/bin/sh
# Railway mounts /data as root. Create the session directory and hand it to the node user
# before Harmony starts. A non-root start leaves the directory as it is.
set -eu
echo "entrypoint: inicia como uid $(id -u)"
dir="${WHATSAPP_SESSION_DIR:-/data/whatsapp-session}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$dir"
  chown -R node:node "$dir"
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all "$@"
fi
exec "$@"

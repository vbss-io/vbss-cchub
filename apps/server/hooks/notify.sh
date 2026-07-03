#!/bin/sh
# Hook do Claude Code para ambientes sem node (ex: WSL). Só precisa de curl.
# Lê o JSON do hook no stdin e repassa cru pro hub, que transforma.

SOURCE="${HUB_SOURCE:-wsl}"
PORT="${HUB_PORT:-4317}"
HOST="${HUB_HOST_TARGET}"

if [ -z "$HOST" ]; then
  for IP in \
    "$(ip route show default 2>/dev/null | awk '{print $3; exit}')" \
    "$(/sbin/ip route show default 2>/dev/null | awk '{print $3; exit}')" \
    "$(/usr/sbin/ip route show default 2>/dev/null | awk '{print $3; exit}')"; do
    if [ -n "$IP" ]; then HOST="$IP"; break; fi
  done
fi
[ -z "$HOST" ] && HOST="127.0.0.1"

curl -s -m 2 -X POST \
  -H 'content-type: application/json' \
  --data-binary @- \
  "http://$HOST:$PORT/hook/raw?source=$SOURCE" >/dev/null 2>&1

exit 0

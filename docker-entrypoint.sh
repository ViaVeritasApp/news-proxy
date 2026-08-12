#!/bin/sh
set -e

# Xvfb started directly rather than through xvfb-run: as PID 1 its SIGUSR1
# readiness handshake takes minutes to complete, and node is a grandchild that
# never receives SIGTERM.
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &

i=0
while [ ! -e /tmp/.X11-unix/X99 ]; do
    i=$((i + 1))
    if [ "$i" -gt 100 ]; then
        echo "Xvfb did not create /tmp/.X11-unix/X99 within 10s" >&2
        exit 1
    fi
    sleep 0.1
done

export DISPLAY=:99

# exec, so node becomes PID 1 and gets signals and stdout directly.
exec node dist/index.js

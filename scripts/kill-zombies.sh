#!/bin/bash
# Script to auto-kill orphaned Chrome processes (zombies with PPID 1)

# Find all Chrome processes whose Parent PID is 1 (init/systemd)
ZOMBIES=$(ps -eo pid,ppid,cmd | grep '[o]pt/google/chrome/chrome' | awk '$2 == 1 {print $1}')

if [ ! -z "$ZOMBIES" ]; then
    echo "Found orphaned Chrome processes. Killing PIDs: $ZOMBIES"
    kill -9 $ZOMBIES
else
    echo "No orphaned Chrome processes found."
fi

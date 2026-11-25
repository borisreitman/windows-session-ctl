#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ctl() { windows-session-ctl "$@"; }

ctl wait --image fixtures/start_menu.png --timeout 0 >/dev/null 2>&1 && exit 0
ctl wait --image fixtures/start_button.png --move
ctl mouse click
ctl wait --image fixtures/start_menu.png

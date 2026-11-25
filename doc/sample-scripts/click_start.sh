#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./common.sh

windows-session-ctl wait --image fixtures/start_menu.png --timeout 0 >/dev/null 2>&1 && exit 0
click_image fixtures/start_button.png
ctl wait --image fixtures/start_menu.png

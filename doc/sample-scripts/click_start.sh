#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./common.sh

require_tools jq
screenshot_on_failure

menu=fixtures/start_menu.png
if windows-session-ctl wait --image "$menu" --timeout 0 >/dev/null 2>&1; then exit 0; fi
click_image fixtures/start_button.png
ctl wait --image "$menu" --timeout 30

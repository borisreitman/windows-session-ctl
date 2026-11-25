#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./common.sh

require_tools jq
screenshot_on_failure

COUNT=SystemSettings_StorageSense_TotalAppsVisible_AppSizesListTotalAppsVisibleText

ctl wait --image fixtures/start_menu.png --timeout 30
ctl type "add or remove programs"
click_image fixtures/add_or_remove_programs.png
ctl wait --window Settings --control "$COUNT" --text found --timeout 60

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./common.sh

ctl wait --image fixtures/start_menu.png
ctl type "add or remove programs"
click_image fixtures/add_or_remove_programs.png
ctl wait --window Settings --control SystemSettings_StorageSense_TotalAppsVisible_AppSizesListTotalAppsVisibleText --text found

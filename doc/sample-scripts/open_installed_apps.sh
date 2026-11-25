#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ctl() { windows-session-ctl "$@"; }

ctl wait --image fixtures/start_menu.png
ctl type "add or remove programs"
ctl wait --image fixtures/add_or_remove_programs.png --move
ctl mouse click
ctl wait --window Settings --control SystemSettings_StorageSense_TotalAppsVisible_AppSizesListTotalAppsVisibleText --text found

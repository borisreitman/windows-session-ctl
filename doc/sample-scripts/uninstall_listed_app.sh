#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./common.sh
require_name "$@"

id=SystemSettings_StorageSense

ctl settext Settings "$name" --control ${id}_AppSizesListFilter_DisplayStringValue
sleep 2
click_control Settings AppOptionsButton --beside "$name"
click_control Settings ${id}_AppSizesList_UninstallButton_UninstallButton
click_control Settings ${id}_AppSizesList_UninstallButton_ConfirmButton
ctl wait --window Settings --control AppOptionsButton --beside "$name" --gone --timeout 120
ctl wait --window Settings --control ${id}_TotalAppsVisible_AppSizesListTotalAppsVisibleText
echo "Uninstalled '$name'."

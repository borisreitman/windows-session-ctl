#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./common.sh

SEARCH=SystemSettings_StorageSense_AppSizesListFilter_DisplayStringValue
COUNT=SystemSettings_StorageSense_TotalAppsVisible_AppSizesListTotalAppsVisibleText
UNINSTALL=SystemSettings_StorageSense_AppSizesList_UninstallButton_UninstallButton
CONFIRM=SystemSettings_StorageSense_AppSizesList_UninstallButton_ConfirmButton

[[ $# == 2 && $1 == --name && -n $2 ]] || die "usage: ${0##*/} --name <app name>" 2
name=$2
require_tools
screenshot_on_failure 2

row=(--window Settings --control AppOptionsButton --beside "$name")

ctl wait --window Settings --control "$COUNT" --text found --timeout 60
ctl settext Settings "$name" --control "$SEARCH"
sleep 2
ctl wait "${row[@]}" --timeout 30
ctl click Settings AppOptionsButton --beside "$name"
ctl wait --window Settings --control "$UNINSTALL" --timeout 30
ctl click Settings "$UNINSTALL"
ctl wait --window Settings --control "$CONFIRM" --timeout 30
ctl click Settings "$CONFIRM"
ctl wait "${row[@]}" --gone --timeout 120
ctl wait --window Settings --control "$COUNT" --timeout 5

echo "Uninstalled '$name'."

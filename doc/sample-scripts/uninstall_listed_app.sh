#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ctl() { windows-session-ctl "$@"; }
[[ $# == 2 && $1 == --name && -n $2 ]] || { echo "usage: ${0##*/} --name <app name>" >&2; exit 2; }
name=$2
id=SystemSettings_StorageSense

ctl settext Settings "$name" --control ${id}_AppSizesListFilter_DisplayStringValue
sleep 2
ctl wait --window Settings --control AppOptionsButton --beside "$name"
ctl click Settings AppOptionsButton --beside "$name"
ctl wait --window Settings --control ${id}_AppSizesList_UninstallButton_UninstallButton
ctl click Settings ${id}_AppSizesList_UninstallButton_UninstallButton
ctl wait --window Settings --control ${id}_AppSizesList_UninstallButton_ConfirmButton
ctl click Settings ${id}_AppSizesList_UninstallButton_ConfirmButton
ctl wait --window Settings --control AppOptionsButton --beside "$name" --gone --timeout 120
ctl wait --window Settings --control ${id}_TotalAppsVisible_AppSizesListTotalAppsVisibleText
echo "Uninstalled '$name'."

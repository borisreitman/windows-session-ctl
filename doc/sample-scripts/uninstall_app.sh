#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./common.sh

[[ $# == 2 && $1 == --name && -n $2 ]] || die "usage: ${0##*/} --name <app name>" 2
screenshot_on_failure 2

./close_settings.sh
./click_start.sh
./open_installed_apps.sh
./uninstall_listed_app.sh --name "$2"
./close_settings.sh

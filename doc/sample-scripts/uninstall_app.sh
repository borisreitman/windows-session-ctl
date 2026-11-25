#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ $# == 2 && $1 == --name && -n $2 ]] || { echo "usage: ${0##*/} --name <app name>" >&2; exit 2; }

./close_settings.sh
./click_start.sh
./open_installed_apps.sh
./uninstall_listed_app.sh "$@"
./close_settings.sh

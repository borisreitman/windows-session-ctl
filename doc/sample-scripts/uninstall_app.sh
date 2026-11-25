#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./common.sh
require_name "$@"

./close_settings.sh
./click_start.sh
./open_installed_apps.sh
./uninstall_listed_app.sh --name "$name"
./close_settings.sh

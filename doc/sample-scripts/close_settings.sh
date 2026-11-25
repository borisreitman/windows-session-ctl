#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./common.sh

require_tools
screenshot_on_failure

ctl psexec 'Stop-Process -Name SystemSettings -Force -ErrorAction SilentlyContinue; exit 0'

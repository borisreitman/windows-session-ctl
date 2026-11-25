#!/usr/bin/env bash
set -euo pipefail
ctl() { windows-session-ctl "$@"; }

ctl psexec 'Stop-Process -Name SystemSettings -Force -ErrorAction SilentlyContinue; exit 0'

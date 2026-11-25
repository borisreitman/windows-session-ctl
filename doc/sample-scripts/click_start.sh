#!/usr/bin/env bash
set -euo pipefail
here=$(dirname "${BASH_SOURCE[0]}")
. "$here/common.sh"

require_tools jq
screenshot_on_failure

found=$(windows-session-ctl wait --image "$here/fixtures/start_button.png" --timeout 30) ||
  die "the Start button is not on screen" $?
read -r x y < <(jq -r '.[0].center | "\(.x) \(.y)"' <<<"$found")
ctl mouse click "$x" "$y"

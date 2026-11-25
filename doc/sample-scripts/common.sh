# Helpers for automation scripts that drive a Windows desktop through `windows-session-ctl`.
# Source it, do not run it:
#
#   . "$(dirname "${BASH_SOURCE[0]}")/common.sh"
#
# Needs `windows-session-ctl` on PATH; call `require_tools` to check. Sourcing only defines functions.
# Works with the bash 3.2 that macOS ships.

log() { echo "$*" >&2; }

die() { # die <message> [exit status]
  log "error: $1"
  exit "${2:-1}"
}

require_tools() { # require_tools [commands the script needs besides windows-session-ctl]
  local tool
  for tool in windows-session-ctl "$@"; do
    command -v "$tool" >/dev/null || die "$tool is not on PATH"
  done
}

# Run a CLI command, keeping its output quiet; if it fails, stop the script and show why.
ctl() {
  local out
  out=$(windows-session-ctl "$@") || die "windows-session-ctl $1 failed: $out"
}

# screenshot_on_failure [exit statuses to ignore]: when the script exits with any other non-zero status, save
# what the Windows screen showed to $TMPDIR/<script name>-failure.png. Takes over the script's EXIT trap.
screenshot_on_failure() {
  _ignored_statuses=" 0 $* "
  trap _failure_screenshot EXIT
}
_failure_screenshot() {
  local status=$? name=${0##*/} shot
  [[ $_ignored_statuses != *" $status "* ]] || return 0
  shot="${TMPDIR:-/tmp}"
  shot="${shot%/}/${name%.sh}-failure.png"
  if windows-session-ctl screenshot "$shot" >/dev/null 2>&1; then log "screenshot of the failure: $shot"; fi
}

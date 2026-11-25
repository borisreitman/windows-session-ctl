ctl() {
  local out
  out=$(windows-session-ctl "$@") || {
    local status=$?
    echo "${0##*/}: windows-session-ctl $1 failed: $out" >&2
    exit "$status"
  }
}

click_image() {
  ctl wait --image "$1" --move
  ctl mouse click
}

click_control() {
  ctl wait --window "$1" --control "${@:2}"
  ctl click "$@"
}

require_name() {
  [[ $# == 2 && $1 == --name && -n $2 ]] || { echo "usage: ${0##*/} --name <app name>" >&2; exit 2; }
  name=$2
}

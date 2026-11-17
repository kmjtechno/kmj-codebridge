#!/usr/bin/env bash
# One entrypoint for existing Linux agents and browser-approved NEW Linux devices.
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ -f "$root/scripts/one-click-linux-device.sh" ]] || {
  echo 'KMJ_DEVICE_ONE_CLICK=BLOCKED_LINUX_ENTRY_MISSING'
  exit 2
}
exec bash "$root/scripts/one-click-linux-device.sh" "$@"

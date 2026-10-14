#!/usr/bin/env bash
#
# Pack an activated AdGuard CLI home into the seed archive and prove the packed copy still holds an
# active licence. Called by seed-adguard-cli-home.sh after activating; run on its own, it slims an
# existing seed without activating another licence device. The AdGuard CLI blocker module ships
# both scripts for its setup action's seed mode.
#
# The archive stays under 500 KiB. The filter databases (`agflm_*.db`, ~53 MB) are what pushes a
# home past that; the CLI rebuilds them on its first command, so they stay out along with the logs.
#
# Usage: pack-adguard-cli-home.sh <adguard-cli> <home> <output.tar.gz>

set -Eeuo pipefail

usage='Usage: pack-adguard-cli-home.sh <adguard-cli> <home> <output.tar.gz>'
cli="${1:?${usage}}"
home="${2:?${usage}}"
output="${3:?${usage}}"

max_bytes=$((500 * 1024))

mkdir -p "$(dirname "${output}")"
tar -czf "${output}" -C "${home}" --exclude='agflm_*.db' --exclude='logs' .

size="$(wc -c < "${output}" | tr -d ' ')"
if (( size > max_bytes )); then
    echo "The seed is ${size} bytes, over the ${max_bytes}-byte limit:" >&2
    tar -tvzf "${output}" | sort -k3 -n -r | head -10 >&2
    exit 1
fi

# The excluded files must not have carried the licence: restore the archive the way a run does and
# ask the CLI.
check="$(mktemp -d /tmp/agcli-check-XXXXXX)"
trap 'rm -rf "${check}"' EXIT
tar -xzf "${output}" -C "${check}"
if ! env -i HOME="${check}" PATH="${PATH}" LANG=en_US.UTF-8 "${cli}" license > /dev/null 2>&1; then
    echo 'The packed home holds no active licence; nothing was seeded.' >&2
    exit 1
fi
echo "Packed the CLI home into ${output} (${size} bytes)."

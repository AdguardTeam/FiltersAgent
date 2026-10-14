#!/usr/bin/env bash
#
# Activate the AdGuard CLI once in a fresh HOME and pack that HOME as the seed every desktop run
# restores (ADGUARD_CLI_HOME_ARCHIVE in the AdGuard CLI module). All runs restored from
# one seed share its single licence device, so the seed is never reset; to free that device,
# unlink it in the AdGuard account and seed again.
#
# Usage: seed-adguard-cli-home.sh <adguard-cli> <output.tar.gz>
#
# Environment:
#   ADGUARD_LICENSE_KEY   Licence to activate. Never echoed: it reaches only the CLI's argv.

set -Eeuo pipefail

cli="${1:?Usage: seed-adguard-cli-home.sh <adguard-cli> <output.tar.gz>}"
output="${2:?Usage: seed-adguard-cli-home.sh <adguard-cli> <output.tar.gz>}"
: "${ADGUARD_LICENSE_KEY:?Missing ADGUARD_LICENSE_KEY}"

# Short on purpose: the CLI's control socket lives under HOME and sun_path is 104 bytes.
home="$(mktemp -d /tmp/agcli-seed-XXXXXX)"
chmod 700 "${home}"
trap 'rm -rf "${home}"' EXIT

run_cli() {
    env -i HOME="${home}" PATH="${PATH}" LANG=en_US.UTF-8 "${cli}" "$@" 2>&1 \
        | sed "s/${ADGUARD_LICENSE_KEY}/[redacted licence]/g"
}

data_dir="$(run_cli --version | sed -n 's/^Created data directory //p')"
if [[ -z "${data_dir}" ]]; then
    echo 'The CLI did not announce its data directory.' >&2
    exit 1
fi

# The CLI refuses every command until it finds a configuration; the run rewrites it anyway.
cat > "${data_dir}/proxy.yaml" <<'YAML'
proxy_mode: manual
show_hints: false
send_crash_reports: false
listen_address: 127.0.0.1
listen_ports:
    http_proxy: 0
    socks5_proxy: -1
filters: []
safebrowsing:
    enabled: false
apps:
    - name: '*'
      action: 'default'
YAML

run_cli activate "${ADGUARD_LICENSE_KEY}"
# `activate` exits 0 even when it only printed a login link; the licence state is the proof.
if ! env -i HOME="${home}" PATH="${PATH}" LANG=en_US.UTF-8 "${cli}" license > /dev/null 2>&1; then
    echo 'The licence did not activate; nothing was seeded.' >&2
    run_cli reset-license || true
    exit 1
fi

printf '%s\n' "${data_dir#"${home}/"}" > "${home}/.agcli-data-dir"
: > "${home}/.agcli-seeded"
if ! bash "$(dirname "${BASH_SOURCE[0]}")/pack-adguard-cli-home.sh" "${cli}" "${home}" "${output}"; then
    # No seed will hold this device, so free it.
    run_cli reset-license || true
    exit 1
fi

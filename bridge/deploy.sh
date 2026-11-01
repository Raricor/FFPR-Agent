#!/usr/bin/env bash
# Build the bridge package and install it into every game on the laptop (0.11.0).
#
#   bash bridge/deploy.sh            # all six
#   bash bridge/deploy.sh ff1 ff5    # only these
#
# The laptop install script skips games that are not installed or are running.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/agent/laptop.env"

games=()
if [[ $# -eq 0 ]]; then
    games=(ff1 ff2 ff3 ff4 ff5 ff6)
else
    for arg in "$@"; do
        case "$arg" in
            ff[1-6]) games+=("$arg") ;;
            *)
                echo "未知的作品 '$arg',可选:ff1 … ff6" >&2
                exit 2
                ;;
        esac
    done
fi

if [[ ! -f "$env_file" ]]; then
    echo "缺少 $env_file:请复制 agent/laptop.env.example 并填写" >&2
    exit 1
fi

# Read one value without sourcing the file.
value() {
    sed -n "s/^$1=//p" "$env_file" | tail -n 1 | tr -d '\r' | sed 's/^"\(.*\)"$/\1/'
}

host="$(value LAPTOP_HOST)"
user="$(value LAPTOP_USER)"
key="$(value LAPTOP_KEY)"
if [[ -z "$key" ]]; then
    key="$HOME/.ssh/ffpr_laptop_ed25519"
else
    key="${key/#\~/$HOME}"
fi
if [[ -z "$host" || -z "$user" ]]; then
    echo "$env_file 里缺少 LAPTOP_HOST 或 LAPTOP_USER" >&2
    exit 1
fi

bash "$root/bridge/build.sh"

# Same options as dsh/src/engine/laptop.ts: the dedicated key only, no agent fallback, no
# password prompt, and one connection reused for the scp/ssh calls below.
options=(
    -i "$key"
    -o IdentitiesOnly=yes
    -o BatchMode=yes
    -o ConnectTimeout=10
    -o WarnWeakCrypto=no
    -o ControlMaster=auto
    -o ControlPersist=300
    -o "ControlPath=$HOME/.ssh/ffpr-cm-%C"
)
remote="$user@$host"
ssh=("ssh" "${options[@]}" "$remote")
scp=("scp" "${options[@]}" -r)

"${ssh[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Remove-Item -Recurse -Force 'C:\\ffpr\\staging\\bridge\\FfprBridge' -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force 'C:\\ffpr\\staging\\bridge' | Out-Null; New-Item -ItemType Directory -Force 'C:\\ffpr\\deploy\\laptop' | Out-Null\""

"${scp[@]}" "$root/bridge/bin/package/FfprBridge" "$remote:C:/ffpr/staging/bridge/"
"${scp[@]}" "$root/deploy/laptop/install-bridge.ps1" "$root/deploy/laptop/FfprCommon.psm1" \
    "$remote:C:/ffpr/deploy/laptop/"

games_arg="$(IFS=,; echo "${games[*]}")"
set +e
# 10-29: Windows PowerShell writes GBK to the pipe by default; ask for UTF-8 so the lines read.
"${ssh[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"[Console]::OutputEncoding = [Text.Encoding]::UTF8; & 'C:\\ffpr\\deploy\\laptop\\install-bridge.ps1' -Games $games_arg; exit \$LASTEXITCODE\""
code=$?
set -e
echo "退出码 $code"
exit "$code"

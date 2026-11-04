#!/usr/bin/env bash
# Build the one bridge package: the loader plus one assembly per game (0.11.0).
#
#   bash bridge/build.sh
#
# Output: bridge/bin/package/FfprBridge/, exactly what every game's
# BepInEx/plugins/FfprBridge/ contains. bridge/deploy.sh builds this and copies it to the laptop.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bridge="$root/bridge"

# dsh/src/engine/laptop.ts's dotnet(): the dev box keeps the SDK in ~/.dotnet.
if command -v dotnet >/dev/null 2>&1; then
    dotnet="$(command -v dotnet)"
else
    dotnet="$HOME/.dotnet/dotnet"
    if [[ -z "${DOTNET_ROOT:-}" ]]; then
        export DOTNET_ROOT="$HOME/.dotnet"
    fi
fi
if [[ ! -x "$dotnet" ]]; then
    echo "找不到 dotnet:$dotnet;装上 .NET SDK 或把它放进 PATH" >&2
    exit 1
fi

echo "编译加载器"
"$dotnet" build "$bridge/loader/FfprBridge.Loader.csproj" -c Release -nologo -v:q

games=(ff1 ff2 ff3 ff4 ff5 ff6)
for game in "${games[@]}"; do
    interop="$root/.deps/$game/interop/Assembly-CSharp.dll"
    if [[ ! -f "$interop" ]]; then
        echo "缺少 $interop:先运行 uv run ffpr-laptop fetch-assemblies $game" >&2
        exit 1
    fi
    echo "编译 $game"
    "$dotnet" build "$bridge" -c Release -p:Game="$game" -nologo -v:q
done

# One package for all six: the loader at the root, the per-game assemblies under games/.
package="$bridge/bin/package/FfprBridge"
rm -rf "$bridge/bin/package"
mkdir -p "$package/games"
cp "$bridge/loader/bin/Release/FfprBridge.dll" "$package/FfprBridge.dll"
for game in "${games[@]}"; do
    cp "$bridge/bin/$game/Release/FfprBridge.$game.dll" "$package/games/FfprBridge.$game.dll"
done

# The laptop installer prints this version; keep it generated from the single source of truth.
version="$(sed -n 's/.*Value = "\([^"]*\)".*/\1/p' "$bridge/src/Version.cs")"
if [[ -z "$version" ]]; then
    echo "读不出 bridge/src/Version.cs 里的版本号" >&2
    exit 1
fi
printf '%s\n' "$version" >"$package/version.txt"

files="$(cd "$bridge/bin/package" && find FfprBridge -type f | sort | tr '\n' ' ')"
echo "$version: ${files% }"

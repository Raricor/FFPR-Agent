#!/usr/bin/env bash
# Compile-check deploy/laptop/BridgeGui.cs the way the laptop will (C# 5, net48, 0 warnings).
#
#   bash deploy/laptop/gui-check/check.sh
#
# The sandbox may only write under the repo, so NuGet's package, HTTP and home directories all
# point into .deps/nuget/. The first run downloads Microsoft.NETFramework.ReferenceAssemblies.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"

export NUGET_PACKAGES="$root/.deps/nuget/packages"
export NUGET_HTTP_CACHE_PATH="$root/.deps/nuget/http"
export DOTNET_CLI_HOME="$root/.deps/nuget/home"

# bridge/build.sh's dotnet(): the dev box keeps the SDK in ~/.dotnet.
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

"$dotnet" build "$here/BridgeGui.check.csproj" -c Release -nologo -v:minimal

#!/usr/bin/env bash
# Builds the extension SDK, from the app repository at the commit sdk.json
# pins, into .sdk/. The indexer and the checks import Studio's own code from
# there (the catalogue format, the git checkout and the content hash), so what
# they compute is what Studio checks at install. Bump the pin deliberately.
#
#   scripts/setup-sdk.sh              build at the pinned commit (skipped when built)
#   SDK_SOURCE=<app checkout> scripts/setup-sdk.sh
#                                     build from a local checkout instead (development)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
pin() { node -e 'const p=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o[k],p); process.stdout.write(typeof v==="string"?v:Object.entries(v).map(([n,ver])=>n+"@"+ver).join(" "))' "$root/sdk.json" "$1"; }
repository="$(pin repository)"
commit="$(pin commit)"
path="$(pin path)"
build_deps="$(pin build)"
stamp="${SDK_SOURCE:+local:}${commit}"

if [ -z "${SDK_SOURCE:-}" ] && [ -f "$root/.sdk/COMMIT" ] && [ "$(cat "$root/.sdk/COMMIT")" = "$stamp" ]; then
  echo "SDK at ${commit} is already built in .sdk/"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ -n "${SDK_SOURCE:-}" ]; then
  mkdir -p "$work/src/$path"
  (cd "$SDK_SOURCE/$path" && tar cf - --exclude node_modules --exclude dist .) | (cd "$work/src/$path" && tar xf -)
else
  git init -q "$work/src"
  git -C "$work/src" remote add origin "$repository"
  git -C "$work/src" sparse-checkout set --no-cone "/$path/" >/dev/null
  git -C "$work/src" fetch -q --depth 1 --filter=blob:none origin "$commit"
  git -C "$work/src" checkout -q FETCH_HEAD
fi

cd "$work/src/$path"
# shellcheck disable=SC2086
npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund $build_deps >/dev/null
npx --no-install tsc -p tsconfig.json

rm -rf "$root/.sdk"
mkdir -p "$root/.sdk"
cp -R dist package.json catalogue.schema.json LICENSE "$root/.sdk/"
printf '%s' "$stamp" > "$root/.sdk/COMMIT"
echo "Built the SDK at ${stamp} into .sdk/"

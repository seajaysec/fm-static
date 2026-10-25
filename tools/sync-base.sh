#!/bin/sh
# Copies fm1-base's update protocol, package reader and m-bootloader installer into vendor/fm1-base/ unmodified, and records the
# commit in vendor/fm1-base/PIN. The copies are never edited here; what fm-static adds lives in src/updater.js.
# Usage: tools/sync-base.sh [path to a fm1-base checkout]   (default: a fresh shallow clone of its main branch)
set -e
cd "$(dirname "$0")/.."
src="$1"; tmp=""
if [ -z "$src" ]; then tmp=$(mktemp -d); git clone --quiet --depth 1 https://github.com/charlesvestal/fm1-base "$tmp"; src="$tmp"; fi
v=vendor/fm1-base
cp "$src/web/fm1ota.js" "$src/web/fm1pkg.js" "$v/"
cp "$src/web/m-bootloader/fm1-uboot-1.2.fwsc" "$src/web/m-bootloader/LICENSE" "$v/m-bootloader/"
cp "$src/LICENSE" "$v/LICENSE-MPL-2.0.txt"
sum() { shasum -a 256 "$1" | cut -c1-64; }
{
  echo "# Files copied unmodified from https://github.com/charlesvestal/fm1-base (MPL-2.0; m-bootloader: MIT)."
  echo "# tools/sync-base.sh rewrites this file. Do not edit the copies: change fm1-base, or the adapter in src/updater.js."
  echo "commit $(git -C "$src" rev-parse HEAD)"
  echo "date $(git -C "$src" log -1 --format=%cd --date=short)"
  echo "web/fm1ota.js $(sum $v/fm1ota.js)"
  echo "web/fm1pkg.js $(sum $v/fm1pkg.js)"
  echo "web/m-bootloader/fm1-uboot-1.2.fwsc $(sum $v/m-bootloader/fm1-uboot-1.2.fwsc)"
} > "$v/PIN"
[ -z "$tmp" ] || rm -rf "$tmp"
node tools/check-vendor.mjs

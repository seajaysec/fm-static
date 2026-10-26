#!/bin/sh
# Copies fm1-base's update protocol, package reader and m-bootloader installer into vendor/fm1-base/ unmodified, and records the
# commit in vendor/fm1-base/SOURCE. The copies are never edited here; what fm-static adds lives in src/updater.js.
# Usage: tools/sync-base.sh [path to a fm1-base checkout]   (default: a fresh shallow clone of its main branch)
set -e
cd "$(dirname "$0")/.."
src="$1"; tmp=""
if [ -z "$src" ]; then tmp=$(mktemp -d); git clone --quiet --depth 1 https://github.com/charlesvestal/fm1-base "$tmp"; src="$tmp"; fi
v=vendor/fm1-base
cp "$src/web/fm1ota.js" "$src/web/fm1pkg.js" "$v/"
cp "$src/web/m-bootloader/fm1-uboot-1.2.fwsc" "$src/web/m-bootloader/LICENSE" "$v/m-bootloader/"
cp "$src/LICENSE" "$v/LICENSE-MPL-2.0.txt"
# the backup and restore protocol: the lines of web/backup/index.html between its "backup protocol" markers, verbatim. They define FW (the
# firmware's name, identity prefix, backup magic, version and file extension, as {{...}} placeholders) and PB, the protocol
awk '/backup protocol: begin/{f=1; next} /backup protocol: end/{f=0} f' "$src/web/backup/index.html" > "$v/backup-protocol.txt"
sum() { shasum -a 256 "$1" | cut -c1-64; }
{
  echo "# Where these files come from: copied unmodified from https://github.com/charlesvestal/fm1-base (MPL-2.0; m-bootloader: MIT)."
  echo "# This is a record, not a freeze: tools/sync-base.sh and the weekly job move it forward to fm1-base's latest.
# Do not edit the copies: change fm1-base, or the adapter in src/updater.js."
  echo "commit $(git -C "$src" rev-parse HEAD)"
  echo "date $(git -C "$src" log -1 --format=%cd --date=short)"
  echo "web/fm1ota.js $(sum $v/fm1ota.js)"
  echo "web/fm1pkg.js $(sum $v/fm1pkg.js)"
  echo "web/m-bootloader/fm1-uboot-1.2.fwsc $(sum $v/m-bootloader/fm1-uboot-1.2.fwsc)"
  echo "web/backup/index.html:protocol $(sum $v/backup-protocol.txt)"
} > "$v/SOURCE"
[ -z "$tmp" ] || rm -rf "$tmp"
node tools/check-vendor.mjs

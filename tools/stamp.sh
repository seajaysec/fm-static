#!/bin/sh
# Sets the page's version everywhere it appears: the footer, the script URL and the module imports (so a new version
# is fetched, never a cached older file), and VERSION in src/app.js (the footer warns when the two disagree).
# Usage: tools/stamp.sh 2026-10-25.2
set -e
v="$1"; [ -n "$v" ] || { echo "usage: $0 VERSION" >&2; exit 2; }
cd "$(dirname "$0")/.."
sed -i.bak -E "s|(id=\"ver-page\">)[^<]*|\1$v|; s|(src/app\.js\?v=)[^\"]*|\1$v|" index.html
sed -i.bak -E "s|^(const VERSION = \")[^\"]*|\1$v|" src/app.js
for f in src/*.js; do sed -i.bak -E "s|(from \"(\./\|\.\./vendor/fm1-base/)[a-z0-9]+\.js)(\?v=[^\"]*)?\"|\1?v=$v\"|" "$f"; done
rm -f index.html.bak src/*.bak
echo "stamped $v"

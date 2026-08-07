#!/bin/bash
# Regenerate the app icons from buildResources/icon.svg (macOS only — uses
# qlmanage + sips + iconutil, all stock). Run after editing the SVG:
#
#   bash scripts/make-icons.sh
#
# Produces:
#   apps/desktop/buildResources/icon.icns  (macOS, electron-builder picks it up)
#   apps/desktop/buildResources/icon.png   (512 px — Linux + dev Dock icon)
#   apps/desktop/buildResources/icon.ico   (Windows — PNG-compressed ICO)
set -euo pipefail

cd "$(dirname "$0")/.."
RES=apps/desktop/buildResources
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Rendered through Chromium, not `qlmanage -t`: QuickLook composites its
# preview onto white, so the icon's rounded corners and the padding around them
# came out opaque white — a white border stuck to the app in the Dock.
MASTER="$TMP/icon.png"
npx electron scripts/render-svg.cjs "$RES/icon.svg" "$MASTER" 1024 >/dev/null 2>&1
[ -f "$MASTER" ] || { echo "electron did not produce a PNG" >&2; exit 1; }

# Guard the thing that was silently wrong before: a corner pixel must be
# transparent. A fully opaque master means the rasteriser flattened the alpha
# again, and every icon built from it would carry a background.
node -e '
  const { execFileSync } = require("node:child_process")
  const out = execFileSync("sips", ["-g", "hasAlpha", process.argv[1]]).toString()
  if (!/hasAlpha:\s*yes/.test(out)) { console.error("master PNG has no alpha channel"); process.exit(1) }
' "$MASTER"

ICONSET="$TMP/icon.iconset"
mkdir "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$MASTER" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$MASTER" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/icon.icns"

sips -z 512 512 "$MASTER" --out "$RES/icon.png" >/dev/null

# Windows ICO: a simple container of PNG-compressed images (Vista+ format).
for size in 16 24 32 48 64 256; do
  sips -z "$size" "$size" "$MASTER" --out "$TMP/ico-$size.png" >/dev/null
done
node - "$TMP" "$RES/icon.ico" <<'EOF'
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const [dir, out] = process.argv.slice(2)
const sizes = [16, 24, 32, 48, 64, 256]
const images = sizes.map((size) => ({ size, data: readFileSync(join(dir, `ico-${size}.png`)) }))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(images.length, 4)
let offset = 6 + images.length * 16
const entries = []
for (const { size, data } of images) {
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size === 256 ? 0 : size, 0) // 0 means 256
  entry.writeUInt8(size === 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2) // palette
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(data.length, 8)
  entry.writeUInt32LE(offset, 12)
  offset += data.length
  entries.push(entry)
}
writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]))
EOF

echo "wrote $RES/icon.icns, $RES/icon.png and $RES/icon.ico"

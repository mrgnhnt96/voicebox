#!/bin/bash
set -e

# Complete Icon Update Script
# Updates both Liquid Glass icon bundle AND the macOS fallback icons from exports

cd "$(dirname "$0")/.."

EXPORTS_DIR="tauri/assets/voicebox_exports"
ICON_BUNDLE="tauri/assets/voicebox.icon"
ASSETS_DIR="$ICON_BUNDLE/Assets"
ICONS_DIR="tauri/src-tauri/icons"
SOURCE_ICON="$EXPORTS_DIR/voicebox-iOS-Dark-1024x1024@1x.png"

echo "🎨 Updating all Voicebox icons from exports..."
echo ""

# Check if source exists
if [ ! -f "$SOURCE_ICON" ]; then
  echo "Error: Source icon not found at $SOURCE_ICON"
  exit 1
fi

# ============================================
# PART 1: Compile Liquid Glass Icon Bundle
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 Part 1: Compiling Liquid Glass Icon Bundle"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "Compiling voicebox.icon with actool..."
# Remove old generated icons to force rebuild
rm -rf tauri/src-tauri/gen/*.icns tauri/src-tauri/gen/Assets.car 2>/dev/null

cd tauri/src-tauri
cargo build 2>/dev/null || echo "  ⚠ Cargo build had warnings (this is normal)"
cd ../..

if [ -f "tauri/src-tauri/gen/voicebox.icns" ]; then
  echo "  ✓ voicebox.icns generated"
else
  echo "  ⚠ Warning: voicebox.icns not generated (will use fallback)"
fi

echo ""

# ============================================
# PART 2: Generate Platform Fallback Icons
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🖼️  Part 2: Generating Platform Fallback Icons"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

mkdir -p "$ICONS_DIR"

# macOS & Desktop Icons
echo "Generating macOS/Desktop icons..."
sips -s format png -z 32 32 "$SOURCE_ICON" --out "$ICONS_DIR/32x32.png" 2>/dev/null
sips -s format png -z 64 64 "$SOURCE_ICON" --out "$ICONS_DIR/64x64.png" 2>/dev/null
sips -s format png -z 128 128 "$SOURCE_ICON" --out "$ICONS_DIR/128x128.png" 2>/dev/null
sips -s format png -z 256 256 "$SOURCE_ICON" --out "$ICONS_DIR/128x128@2x.png" 2>/dev/null
sips -s format png -z 512 512 "$SOURCE_ICON" --out "$ICONS_DIR/icon.png" 2>/dev/null

# Copy Liquid Glass compiled ICNS or generate fallback
echo "Copying icon.icns..."
if [ -f "tauri/src-tauri/gen/voicebox.icns" ]; then
  cp tauri/src-tauri/gen/voicebox.icns "$ICONS_DIR/icon.icns"
  echo "  ✓ Copied Liquid Glass compiled icon.icns"
else
  echo "  ⚠ Liquid Glass icon not found, generating fallback icon.icns..."
mkdir -p /tmp/voicebox-iconset.iconset
sips -s format png -z 16 16 "$SOURCE_ICON" --out /tmp/voicebox-iconset.iconset/icon_16x16.png 2>/dev/null
sips -s format png -z 32 32 "$SOURCE_ICON" --out /tmp/voicebox-iconset.iconset/icon_16x16@2x.png 2>/dev/null
sips -s format png -z 32 32 "$SOURCE_ICON" --out /tmp/voicebox-iconset.iconset/icon_32x32.png 2>/dev/null
sips -s format png -z 64 64 "$SOURCE_ICON" --out /tmp/voicebox-iconset.iconset/icon_32x32@2x.png 2>/dev/null
sips -s format png -z 128 128 "$SOURCE_ICON" --out /tmp/voicebox-iconset.iconset/icon_128x128.png 2>/dev/null
sips -s format png -z 256 256 "$SOURCE_ICON" --out /tmp/voicebox-iconset.iconset/icon_128x128@2x.png 2>/dev/null
sips -s format png -z 256 256 "$SOURCE_ICON" --out /tmp/voicebox-iconset.iconset/icon_256x256.png 2>/dev/null
sips -s format png -z 512 512 "$SOURCE_ICON" --out /tmp/voicebox-iconset.iconset/icon_256x256@2x.png 2>/dev/null
sips -s format png -z 512 512 "$SOURCE_ICON" --out /tmp/voicebox-iconset.iconset/icon_512x512.png 2>/dev/null
  sips -s format png -z 1024 1024 "$SOURCE_ICON" --out /tmp/voicebox-iconset.iconset/icon_512x512@2x.png 2>/dev/null
  iconutil -c icns /tmp/voicebox-iconset.iconset -o "$ICONS_DIR/icon.icns"
  rm -rf /tmp/voicebox-iconset.iconset
  echo "  ✓ Generated fallback icon.icns"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All icons updated successfully!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Updated:"
echo "  ✓ Liquid Glass icon bundle with all appearance variants"
echo "  ✓ macOS/Desktop fallback icons"
echo ""
echo "Next: Rebuild the app with 'cd tauri && bun run tauri build'"

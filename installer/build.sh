#!/usr/bin/env bash
# Builds installer/dist/WiFiAttendance-Setup.exe on Linux/macOS (needs: curl, npm, tar, makensis [apt install nsis]).
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_VERSION="${NODE_VERSION:-22.22.2}"
PG_PKG="${PG_PKG:-@embedded-postgres/windows-x64@17.10.0-beta.17}"   # PostgreSQL 17 Windows binaries
VERSION="$(node -p "require('./package.json').version")"
WORK=installer/work; STAGE=$WORK/stage; mkdir -p installer/dist "$WORK" && rm -rf "$STAGE" && mkdir -p "$STAGE/app" "$STAGE/node" "$STAGE/postgres"

echo "== Node.js $NODE_VERSION (windows x64)"
if [ ! -f "$WORK/node.exe" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/win-x64/node.exe" -o "$WORK/node.exe"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
  expected=$(grep " win-x64/node.exe$" "$WORK/SHASUMS256.txt" | cut -d' ' -f1)
  actual=$(sha256sum "$WORK/node.exe" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || { echo "node.exe checksum mismatch"; rm -f "$WORK/node.exe"; exit 1; }
fi
cp "$WORK/node.exe" "$STAGE/node/node.exe"

echo "== PostgreSQL ($PG_PKG)"
if [ ! -d "$WORK/pg" ]; then
  mkdir -p "$WORK/pg" && (cd "$WORK" && npm pack "$PG_PKG" >/dev/null && tar xzf embedded-postgres-*.tgz -C pg && rm -f embedded-postgres-*.tgz)
fi
cp -r "$WORK/pg/package/native/." "$STAGE/postgres/"
rm -f "$STAGE/postgres/pg-symlinks.json"

echo "== App"
cp -r package.json package-lock.json src public "$STAGE/app/"
(cd "$STAGE/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
cp LICENSE* "$STAGE/" 2>/dev/null || true

echo "== Installer"
makensis -V2 -DVERSION="$VERSION" -DSTAGE="$(pwd)/$STAGE" -DOUTFILE="$(pwd)/installer/dist/WiFiAttendance-Setup.exe" installer/installer.nsi
ls -lh installer/dist/WiFiAttendance-Setup.exe
sha256sum installer/dist/WiFiAttendance-Setup.exe

#!/usr/bin/env bash
# Downloads the pinned WebdriverIO native demo app builds into ./apps.
set -euo pipefail

VERSION="v2.2.0"
BASE="https://github.com/webdriverio/native-demo-app/releases/download/${VERSION}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/apps"

mkdir -p "$DIR"
curl -fsSL -o "$DIR/android.apk" "$BASE/android.wdio.native.app.${VERSION}.apk"
curl -fsSL -o "$DIR/ios.zip" "$BASE/ios.simulator.wdio.native.app.${VERSION}.zip"
unzip -oq "$DIR/ios.zip" -d "$DIR"
rm "$DIR/ios.zip"

echo "Demo app ${VERSION} ready in $DIR"

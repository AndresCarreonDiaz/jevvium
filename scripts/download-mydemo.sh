#!/usr/bin/env bash
# Downloads Sauce Labs' My Demo App for the iOS Simulator into ./apps/mydemo-ios.
# The app belongs to Sauce Labs and is not redistributed here; it is fetched from their release.
set -euo pipefail

VERSION="2.3.0"
URL="https://github.com/saucelabs/my-demo-app-ios/releases/download/${VERSION}/SauceLabs-Demo-App.Simulator.zip"
DIR="$(cd "$(dirname "$0")/.." && pwd)/apps"

mkdir -p "$DIR"
curl -fsSL -o "$DIR/mydemo-ios.zip" "$URL"
rm -rf "$DIR/mydemo-ios"
unzip -oq "$DIR/mydemo-ios.zip" -d "$DIR/mydemo-ios"
rm "$DIR/mydemo-ios.zip"

echo "My Demo App ${VERSION} ready in $DIR/mydemo-ios/Payload/My Demo App.app"

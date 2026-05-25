#!/usr/bin/env bash
set -euo pipefail

bundle_dir="${1:-src-tauri/target/release/bundle}"

app_paths=("$bundle_dir"/macos/*.app)
dmg_paths=("$bundle_dir"/dmg/*.dmg)

if [[ ! -e "${app_paths[0]}" ]]; then
  echo "No .app bundle found in $bundle_dir/macos" >&2
  exit 1
fi

if [[ ! -e "${dmg_paths[0]}" ]]; then
  echo "No .dmg bundle found in $bundle_dir/dmg" >&2
  exit 1
fi

app_path="${app_paths[0]}"
dmg_path="${dmg_paths[0]}"

echo "Verifying app signature: $app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"
codesign -dv --verbose=4 "$app_path" 2>&1 | awk '/Authority=|TeamIdentifier=|Runtime Version=|Signature=/'
spctl -a -vvv -t exec "$app_path"

echo
echo "Verifying DMG signature: $dmg_path"
codesign --verify --verbose=2 "$dmg_path"
codesign -dv --verbose=4 "$dmg_path" 2>&1 | awk '/Authority=|TeamIdentifier=|Signature=/'
spctl -a -vvv -t open --context context:primary-signature "$dmg_path"

echo
echo "Validating notarization tickets"
xcrun stapler validate "$app_path"
xcrun stapler validate "$dmg_path"

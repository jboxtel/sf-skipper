#!/usr/bin/env bash
# Build skipper.zip for Chrome Web Store submission.
#
# Uses an explicit allowlist of the files the extension actually loads at
# runtime. Anything not on the list — local creds, dev notes, screenshots,
# tests, node_modules, .git, evals — stays out of the ZIP, by construction.
#
# Verify the listing matches what the manifest declares before uploading:
#   ./package.sh && unzip -l skipper.zip

set -euo pipefail
cd "$(dirname "$0")"

OUT="skipper.zip"
rm -f "$OUT"

# Order intentionally mirrors manifest.json's content_scripts.js array, then
# everything else the manifest references.
FILES=(
  manifest.json

  # Background + provider adapters
  background.js
  providers.js

  # Action popup
  popup.html
  popup.js

  # Options page
  options.html
  options.css
  options.js

  # Content scripts (must match manifest.json content_scripts.js order)
  salesforce-urls.js
  shared.js
  cache-factory.js
  objects.js
  cmdt.js
  flows.js
  apps.js
  labels.js
  permsets.js
  flow-debug.js
  commands.js
  soql.js
  ask.js
  markdown.js
  onboarding.js
  content.js
  content.css

  # Icons referenced by manifest.json action.default_icon + top-level icons
  icons/icon16.png
  icons/icon32.png
  icons/icon48.png
  icons/icon128.png
)

# Sanity check: refuse to build if any file in the allowlist is missing —
# better to fail loudly than ship a broken extension.
for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "missing file: $f" >&2
    exit 1
  fi
done

zip "$OUT" "${FILES[@]}" >/dev/null
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT"

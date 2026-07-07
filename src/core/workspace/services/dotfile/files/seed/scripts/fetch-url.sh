#!/usr/bin/env bash
# Download a URL into a target directory and write a hidden metadata sidecar
# listing the virtual paths the resulting file should be linked to once indexed
# (consumed by the incoming-metadata-linker hook).
#
# Usage: fetch-url.sh <url> <target-dir> [link-path]
set -euo pipefail

URL="${1:?url required}"
TARGET_DIR="${2:?target dir required}"
LINK_PATH="${3:-/}"

if ! command -v curl >/dev/null 2>&1; then
    echo "fetch-url.sh: curl not installed, skipping" >&2
    exit 0
fi

mkdir -p "$TARGET_DIR"

# Filename from the URL path, query string stripped.
NAME="$(basename "${URL%%\?*}")"
[ -n "$NAME" ] || NAME="download.$$"
FILE_PATH="$TARGET_DIR/$NAME"

# Never clobber an existing file.
if [ -e "$FILE_PATH" ]; then
    BASE="${NAME%.*}"; EXT="${NAME##*.}"
    [ "$BASE" = "$EXT" ] && EXT="" || EXT=".$EXT"
    FILE_PATH="$TARGET_DIR/${BASE}-$$${EXT}"
fi

curl -fsSL -o "$FILE_PATH" "$URL" || { rm -f "$FILE_PATH"; exit 0; }

# Hidden sidecar (leading dot) so it is not auto-indexed; the
# incoming-metadata-linker hook consumes and deletes it.
META="$(dirname "$FILE_PATH")/.$(basename "$FILE_PATH").metadata.json"
cat > "$META" <<EOF
{
  "file": "$(basename "$FILE_PATH")",
  "source": "$URL",
  "paths": ["$LINK_PATH"]
}
EOF

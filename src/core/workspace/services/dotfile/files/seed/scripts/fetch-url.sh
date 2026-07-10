#!/usr/bin/env bash
# Download a URL into a target directory and print the resulting file's
# absolute path on stdout (the calling hook inserts it into the index through
# the front door).
#
# Usage: fetch-url.sh <url> <target-dir>
set -euo pipefail

URL="${1:?url required}"
TARGET_DIR="${2:?target dir required}"

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

echo "$FILE_PATH"

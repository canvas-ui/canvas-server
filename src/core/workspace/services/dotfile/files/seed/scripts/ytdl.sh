#!/usr/bin/env bash
# Download a video with yt-dlp and print the resulting file's absolute path on
# stdout (the calling hook inserts it into the index through the front door).
#
# Usage: ytdl.sh <url> <target-dir>
set -euo pipefail

URL="${1:?url required}"
TARGET_DIR="${2:?target dir required}"

if ! command -v yt-dlp >/dev/null 2>&1; then
    echo "ytdl.sh: yt-dlp not installed, skipping" >&2
    exit 0
fi

mkdir -p "$TARGET_DIR"

PRINTED="$TARGET_DIR/.ytdl.$$"
yt-dlp \
    -o "$TARGET_DIR/%(title)s [%(id)s].%(ext)s" \
    --print-to-file after_move:filepath "$PRINTED" \
    --no-progress \
    "$URL" >&2 || { rm -f "$PRINTED"; exit 0; }

FILE_PATH="$(tail -n1 "$PRINTED" 2>/dev/null || true)"
rm -f "$PRINTED"
[ -n "$FILE_PATH" ] || exit 0

echo "$FILE_PATH"

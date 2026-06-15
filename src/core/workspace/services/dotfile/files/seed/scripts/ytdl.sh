#!/usr/bin/env bash
# Download a video with yt-dlp and write a hidden metadata sidecar listing the
# virtual paths the resulting file should be linked to once indexed.
#
# Usage: ytdl.sh <url> <target-dir> [link-path]
set -euo pipefail

URL="${1:?url required}"
TARGET_DIR="${2:?target dir required}"
LINK_PATH="${3:-/}"

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
    "$URL" || { rm -f "$PRINTED"; exit 0; }

FILE_PATH="$(tail -n1 "$PRINTED" 2>/dev/null || true)"
rm -f "$PRINTED"
[ -n "$FILE_PATH" ] || exit 0

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

#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

ROOT="$(git_root)"

mapfile -t ITEMS < <(read_encrypted_index "$ROOT" || true)
if (( ${#ITEMS[@]} == 0 )); then
	exit 0
fi

PASS="$(prompt_pass 'Dotfiles encryption passphrase: ')"

cleanup() {
	# Best-effort: ensure no leftover plaintext when we meant to encrypt
	for rel in "${ITEMS[@]}"; do
		[[ -z "$rel" ]] && continue
		plain="$ROOT/$rel"
		enc="$plain.encrypted"
		if [[ -f "$plain" && ! -f "$enc" ]]; then
			rm -f -- "$plain" || true
		fi
	done
}
trap cleanup INT TERM

for rel in "${ITEMS[@]}"; do
	[[ -z "$rel" ]] && continue
	plain="$ROOT/$rel"
	enc="$plain.encrypted"
	if [[ -f "$plain" ]]; then
		encrypt_file_atomic "$plain" "$enc" "$PASS"
		rm -f -- "$plain"
		ensure_gitignore_line "$ROOT" "$rel"
	fi
done

exit 0


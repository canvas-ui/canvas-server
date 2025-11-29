#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

ROOT="$(git_root)"

if has_unmerged_conflicts_encrypted; then
	echo "Encrypted files have merge conflicts. Resolve them before decryption." >&2
	exit 1
fi

# Find all *.encrypted files under repo (excluding .git)
mapfile -t ENCRYPTED < <(cd "$ROOT" && git ls-files | grep -E '\\.encrypted$' || true)
if (( ${#ENCRYPTED[@]} == 0 )); then
	exit 0
fi

PASS="$(prompt_pass 'Dotfiles decryption passphrase: ')"

for relenc in "${ENCRYPTED[@]}"; do
	[[ -z "$relenc" ]] && continue
	enc="$ROOT/$relenc"
	plain_rel="${relenc%.encrypted}"
	plain="$ROOT/$plain_rel"
	decrypt_file_atomic "$enc" "$plain" "$PASS"
done

exit 0


#!/usr/bin/env bash
set -euo pipefail

git_root() {
	git rev-parse --show-toplevel
}

has_unmerged_conflicts_encrypted() {
	git diff --name-only --diff-filter=U | grep -E '\\.encrypted$' >/dev/null 2>&1
}

prompt_pass() {
	local prompt_msg="${1:-Passphrase: }"
	if [[ -n "${CANVAS_DOT_PASSPHRASE:-}" ]]; then
		echo -n "$CANVAS_DOT_PASSPHRASE"
		return 0
	fi
	read -r -s -p "$prompt_msg" pass
	echo
	echo -n "$pass"
}

read_encrypted_index() {
	local root="$1"
	local idx="$root/.dot/encrypted.index"
	if [[ -f "$idx" ]]; then
		# shellcheck disable=SC2002
		cat "$idx" | sed '/^\s*$/d'
	fi
}

ensure_gitignore_line() {
	local root="$1"; shift
	local line="$1"
	local gi="$root/.gitignore"
	if [[ -f "$gi" ]]; then
		grep -Fx -- "$line" "$gi" >/dev/null 2>&1 || echo "$line" >>"$gi"
	else
		echo "$line" >"$gi"
	fi
}

encrypt_file_atomic() {
	local plain="$1"; shift
	local enc="$1"; shift
	local pass="$1"
	local tmp="$enc.tmp.$$"
	# OpenSSL enc with AES-256-GCM; stores salt/tag in output; PBKDF2 derivation
	openssl enc -aes-256-gcm -pbkdf2 -md sha256 -salt -in "$plain" -out "$tmp" -pass pass:"$pass"
	mv -f "$tmp" "$enc"
}

decrypt_file_atomic() {
	local enc="$1"; shift
	local plain="$1"; shift
	local pass="$1"
	local tmp="$plain.tmp.$$"
	openssl enc -d -aes-256-gcm -pbkdf2 -md sha256 -in "$enc" -out "$tmp" -pass pass:"$pass"
	mv -f "$tmp" "$plain"
}



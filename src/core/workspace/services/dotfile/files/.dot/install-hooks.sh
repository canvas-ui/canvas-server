#!/usr/bin/env bash
set -euo pipefail

force=0
if [[ "${1:-}" == "--force" ]]; then
  force=1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
hooks_dir="$repo_root/.git/hooks"

if [[ ! -d "$hooks_dir" ]]; then
  echo "No .git directory found; run inside a cloned dotfiles repository" >&2
  exit 1
fi

install_hook() {
  local name="$1"
  local target="$hooks_dir/$name"
  if [[ -f "$target" && $force -eq 0 ]]; then
    echo "Hook $name already installed; skipping (use --force to overwrite)"
    return 0
  fi
  cat > "$target" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
bash "$repo_root/.dot/hooks/$(basename "$0").sh" "$@" || exit $?
EOF
  chmod +x "$target"
  echo "Installed $name hook"
}

install_hook pre-push
install_hook post-merge
install_hook post-checkout
install_hook post-rewrite

echo "Hooks installed."


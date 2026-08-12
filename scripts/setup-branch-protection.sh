#!/usr/bin/env bash
# Branch protection for the dual-licensed Canvas repos (+ monorepo packages/*).
# Requires: GH_TOKEN env var with repo Administration:write on canvas-ui/*.
#   GH_TOKEN=github_pat_xxx bash scripts/setup-branch-protection.sh
#
# Settings chosen for a solo-maintainer + outside-PR workflow:
#   - required status check: the `cla` job (CLA Assistant) — blocks unsigned PRs
#   - enforce_admins: false — YOUR direct pushes to protected branches keep
#     working exactly as today; only non-admin pushes/PRs are gated
#   - no required reviews, no push restrictions, force-pushes stay blocked
#     for non-admins (GitHub default)
set -euo pipefail

: "${GH_TOKEN:?set GH_TOKEN to a token with Administration:write on canvas-ui repos}"

protect() {
    local repo="$1" branch="$2"
    printf '%-22s %-5s ' "$repo" "$branch"
    code=$(curl -s -o /tmp/bp-resp.json -w '%{http_code}' \
        -X PUT \
        -H "Authorization: Bearer $GH_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "https://api.github.com/repos/canvas-ui/$repo/branches/$branch/protection" \
        -d '{
              "required_status_checks": { "strict": false, "contexts": ["cla"] },
              "enforce_admins": false,
              "required_pull_request_reviews": null,
              "restrictions": null,
              "allow_force_pushes": false,
              "allow_deletions": false
            }')
    if [ "$code" = "200" ]; then
        echo "OK"
    else
        echo "FAILED ($code)"; head -c 300 /tmp/bp-resp.json; echo
    fi
}

protect canvas         main   # CLA check is required-safe: apps-only PRs report success
protect canvas-server  dev    # contribution target
protect canvas-server  main   # release branch
protect canvas-stored  main
protect canvas-synapsd main
protect canvas-inferd  main
protect canvas-agentd  main

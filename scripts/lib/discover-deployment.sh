#!/usr/bin/env bash
#
# Where is this deployment? — shared by update-git.sh and install-inferd-ubuntu.sh.
#
# /opt/canvas-server is a default, not a fact: a deployment lands wherever its
# storage is (a ZFS dataset, /srv, a service user's home) and runs as whatever
# user the install chose. A script that assumes the default does not merely pick
# a wrong path — it writes that wrong path into a systemd unit, and the unit
# then fails at CHDIR before the process it supervises ever starts.
#
# Sourced, never executed. Set DEPLOY_SELF to the calling script's $0 before
# sourcing (defaults to $0, which is already right when sourced at top level).
#
# discover_deployment() sets, without overwriting a value already in the
# environment:
#   CANVAS_ROOT         the checkout
#   CANVAS_ROOT_SOURCE  how it was found — printed by the callers, so an
#                       operator can see which piece of evidence won
#   UNIT_ROOT UNIT_USER UNIT_GROUP UNIT_SERVER_HOME
#                       what the installed service actually uses right now;
#                       callers decide how those rank against their own config

DEPLOY_UNIT="${DEPLOY_UNIT:-canvas-server.service}"
DEPLOY_SELF="${DEPLOY_SELF:-$0}"

# One systemd property of the unit, empty when there is no unit (or no systemd).
unit_prop() {
    systemctl show "$DEPLOY_UNIT" -p "$1" --value 2>/dev/null
}

# One key out of the unit's Environment= (space-separated K=V pairs).
unit_env() {
    local key=$1 pairs
    pairs=$(unit_prop Environment)
    [[ -n "$pairs" ]] || return 0
    tr ' ' '\n' <<<"$pairs" | sed -n "s/^${key}=//p" | tail -n 1
}

# A canvas-server checkout, not just any directory. update-git.sh does a hard
# `git reset` inside whatever this accepts, so a wrong guess has to fail the
# test rather than wipe someone's files.
is_canvas_root() {
    local dir=${1%/}
    [[ -n "$dir" && -d "$dir/.git" && -f "$dir/package.json" ]] || return 1
    grep -q '"name": *"canvas-server"' "$dir/package.json" 2>/dev/null
}

# Sets CANVAS_ROOT + CANVAS_ROOT_SOURCE. Candidates, best evidence first.
detect_canvas_root() {
    local candidate

    # 1. The checkout the calling script was run from — right by construction
    #    for "$CANVAS_ROOT/scripts/<script>.sh", including from cron, and true
    #    without a unit, a config file or an .env existing yet.
    candidate=$(cd "$(dirname "$(readlink -f "$DEPLOY_SELF")")/.." 2>/dev/null && pwd)
    if is_canvas_root "$candidate"; then
        CANVAS_ROOT="$candidate"; CANVAS_ROOT_SOURCE="this checkout"; return 0
    fi

    # 2. What the installed service is running out of.
    if is_canvas_root "${UNIT_ROOT-}"; then
        CANVAS_ROOT="${UNIT_ROOT%/}"; CANVAS_ROOT_SOURCE="$DEPLOY_UNIT"; return 0
    fi

    # 3. The service user's home — installs commonly make the checkout that
    #    user's home directory (passwd entries often end in "/").
    local user=${CANVAS_USER:-${UNIT_USER:-canvas}}
    candidate=$(getent passwd "$user" 2>/dev/null | cut -d: -f6)
    if is_canvas_root "$candidate"; then
        CANVAS_ROOT="${candidate%/}"; CANVAS_ROOT_SOURCE="$user home"; return 0
    fi

    CANVAS_ROOT="/opt/canvas-server"; CANVAS_ROOT_SOURCE="default"
}

discover_deployment() {
    UNIT_ROOT=$(unit_prop WorkingDirectory)
    UNIT_USER=$(unit_prop User)
    UNIT_GROUP=$(unit_prop Group)
    UNIT_SERVER_HOME=$(unit_env CANVAS_SERVER_HOME)

    if [[ -n "${CANVAS_ROOT-}" ]]; then
        CANVAS_ROOT="${CANVAS_ROOT%/}"
        CANVAS_ROOT_SOURCE="environment"
        return 0
    fi
    detect_canvas_root
}

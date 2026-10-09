#!/usr/bin/env bash
# Run the dev-loop skill unattended, one fresh Claude session per task.
# State lives in .claude/dev-loop/{log.md,STATUS}, so each run starts with a clean context.
#
# Usage: [MODEL=sonnet] [STYLE=caveman|normal] [SKIP_PREFLIGHT=1] scripts/dev-loop.sh [max-iterations]
#   MODEL           model for the orchestrating session (default: sonnet). Subagent models are
#                   chosen per task by the model-router skill.
#   STYLE           caveman (default) or normal. caveman = terse caveman-ultra output.
#   SKIP_PREFLIGHT  1 to skip the clean-tree and workspace-trust checks.
#   max-iterations  default 40
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
MAX="${1:-40}"
MODEL="${MODEL:-sonnet}"
STYLE="${STYLE:-caveman}"
STATE_DIR=".claude/dev-loop"
mkdir -p "$STATE_DIR"

case "$STYLE" in
  caveman) STYLE_ARG="" ;;
  normal) STYLE_ARG=" normal" ;;
  *) echo "STYLE must be 'caveman' or 'normal', got '$STYLE'" >&2; exit 2 ;;
esac

preflight() {
  # 1. Clean working tree: the loop stops on changes it did not make.
  if [ -n "$(git status --porcelain)" ]; then
    echo "preflight: working tree is not clean. Commit or stash first:" >&2
    git status --short >&2
    return 1
  fi

  # 2. Workspace trust: headless runs ignore .claude/settings.json permissions when untrusted.
  local trusted
  trusted="$(python3 -I - "$ROOT" <<'PY'
import json, os, sys
root = sys.argv[1]
try:
    projects = json.load(open(os.path.expanduser("~/.claude.json"))).get("projects", {})
except Exception:
    print("no"); raise SystemExit
path = root
while True:
    if projects.get(path, {}).get("hasTrustDialogAccepted"):
        print("yes"); break
    parent = os.path.dirname(path)
    if parent == path:
        print("no"); break
    path = parent
PY
)"
  if [ "$trusted" != "yes" ]; then
    echo "preflight: workspace is not trusted, so the permission allowlist would be ignored." >&2
    echo "  Run 'claude' in $ROOT once and accept the trust dialog, or set SKIP_PREFLIGHT=1." >&2
    return 1
  fi
}

if [ "${SKIP_PREFLIGHT:-0}" != "1" ]; then
  preflight || exit 1
fi

for ((i = 1; i <= MAX; i++)); do
  echo "=== dev-loop iteration $i/$MAX model=$MODEL style=$STYLE $(date '+%F %T') ==="
  echo "continue" > "$STATE_DIR/STATUS"

  # Permissions come from .claude/settings.json (allowlist + denylist).
  claude -p "/dev-loop unattended headless max=$MAX$STYLE_ARG" \
    --model "$MODEL" \
    --permission-mode acceptEdits \
    2>&1 | tee -a "$STATE_DIR/run.log" || echo "claude exited non-zero; checking STATUS"

  status="$(cat "$STATE_DIR/STATUS" 2>/dev/null || echo 'stop: no status written')"
  echo "status: $status"
  case "$status" in
    stop:*) echo "stopping: ${status#stop: }"; exit 0 ;;
  esac
  sleep 5
done

echo "reached max iterations ($MAX)"

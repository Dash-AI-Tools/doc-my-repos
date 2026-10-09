#!/usr/bin/env bash
# Run the dev-loop skill unattended, one fresh Claude session per task.
# State lives in .claude/dev-loop/{log.md,STATUS}, so each run starts with a clean context.
#
# Usage: scripts/dev-loop.sh [max-iterations]   (default 40)
set -euo pipefail

cd "$(dirname "$0")/.."
MAX="${1:-40}"
STATE_DIR=".claude/dev-loop"
mkdir -p "$STATE_DIR"

for ((i = 1; i <= MAX; i++)); do
  echo "=== dev-loop iteration $i/$MAX $(date '+%F %T') ==="
  echo "continue" > "$STATE_DIR/STATUS"

  # Permissions come from .claude/settings.json (allowlist + denylist).
  claude -p "/dev-loop unattended headless max=$MAX" \
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

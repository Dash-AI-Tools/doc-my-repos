#!/usr/bin/env bash
# Implementation + verification loop for ONE OpenSpec change, driven by opencode.
#
# For each unchecked task in openspec/changes/<change>/tasks.md, in file order:
#   1. a fresh `loop-implementer` session implements it and writes its tests,
#   2. this script runs the repo checks (typecheck, lint, format, tests),
#   3. failing checks go back to a fresh implementer run (up to FIX_ROUNDS times),
#   4. this script ticks the box and makes one commit,
#   5. when the last task of an epic (a numbered group) closes, ONE read-only
#      `loop-verifier` session checks the whole epic against the specs; blocking
#      findings get one fix run, and there is never a re-review.
# A task that is blocked or keeps failing is parked (its work is saved in a git
# stash) and the loop moves on. Nothing is ever pushed.
#
# Usage: scripts/opencode-loop.sh <change-name> [max-iterations]
#
# Environment:
#   OC_MODEL         implementer model, provider/model (default: opencode's configured default)
#   OC_VERIFY_MODEL  verifier model (default: OC_MODEL). A stronger model here pays off.
#   VERIFY           epic (default) | task | off
#   FIX_ROUNDS       fix runs per task after checks fail (default 2)
#   TASK_TIMEOUT     seconds per implementer run (default 2400)
#   VERIFY_TIMEOUT   seconds per verifier run (default 1500)
#   PARK_LIMIT       stop after this many parked tasks in a row (default 3)
#   BRANCH           working branch (default loop/<change>)
#   GATE             newline-separated check commands (default typecheck, lint, format:check, test)
#   ONLY             run just this task label (for example 2.3) and stop
#   UNPARK           task label to remove from the parked list before starting
#   SKIP_DB          1 to skip `pnpm db:up`
#   SKIP_BASELINE    1 to skip the check run on the starting commit
#   DRY_RUN          1 to print the next task and its prompt, change nothing, call no model
#   OC_BIN           opencode binary (default opencode)
#
# State (git-ignored): .opencode-loop/<change>/{log.md,STATUS,parked.txt,runs/,reviews/}
set -euo pipefail

cd "$(dirname "$0")/.."

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

CHANGE="${1:-}"
MAX="${2:-60}"
case "$CHANGE" in
  "" | -h | --help) usage; exit 2 ;;
  *[!a-z0-9-]*) echo "change name must be kebab-case, got '$CHANGE'" >&2; exit 2 ;;
esac
[ -d "openspec/changes/$CHANGE" ] || { echo "no such change: openspec/changes/$CHANGE" >&2; exit 2; }

OC_BIN="${OC_BIN:-opencode}"
OC_MODEL="${OC_MODEL:-}"
OC_VERIFY_MODEL="${OC_VERIFY_MODEL:-$OC_MODEL}"
VERIFY="${VERIFY:-epic}"
FIX_ROUNDS="${FIX_ROUNDS:-2}"
TASK_TIMEOUT="${TASK_TIMEOUT:-2400}"
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-1500}"
PARK_LIMIT="${PARK_LIMIT:-3}"
BRANCH="${BRANCH:-loop/$CHANGE}"
ONLY="${ONLY:-}"
DRY_RUN="${DRY_RUN:-0}"
DEFAULT_GATE=$'pnpm typecheck\npnpm lint\npnpm format:check\npnpm test'
GATE="${GATE:-$DEFAULT_GATE}"

case "$VERIFY" in epic | task | off) ;; *) echo "VERIFY must be epic, task or off" >&2; exit 2 ;; esac

STATE=".opencode-loop/$CHANGE"
LOG="$STATE/log.md"
PARKED="$STATE/parked.txt"
APPLY="$STATE/apply.json"
TASKS_FILE="openspec/changes/$CHANGE/tasks.md"
mkdir -p "$STATE/runs" "$STATE/reviews"
touch "$PARKED" "$LOG"

# Paths the implementer must never change. Anything it touches here is reverted.
PROTECTED=(openspec .opencode .claude opencode.json scripts/opencode-loop.sh)
# The opencode-loop plugin appends to this tracked log whenever opencode starts, so it
# must never count as a change, be stashed, committed or reverted.
NOISE=':!.opencode/opencode-loop'

# --- helpers -----------------------------------------------------------------

dirty() { git status --porcelain -- . "$NOISE"; }

note() { # TAG message
  printf '%s | %s | %s\n' "$(date '+%F %T')" "$1" "$2" >> "$LOG"
  printf '[%s] %s\n' "$1" "$2"
}

# Small JSON/markdown helper. Subcommands read $APPLY (output of
# `openspec instructions apply --json`) and never print anything but data.
read -r -d '' TASKS_PY <<'PY' || true
import json, re, sys

def load(path):
    return json.load(open(path))

def parked(path):
    try:
        return {l.split("|")[0].strip() for l in open(path) if l.strip()}
    except FileNotFoundError:
        return set()

def tasks(d):
    out = []
    for t in d["tasks"]:
        m = re.match(r"(\d+)\.(\d+)\s+(.*)", t["description"], re.S)
        if m:
            out.append({
                "label": m.group(1) + "." + m.group(2),
                "epic": m.group(1),
                "text": " ".join(m.group(3).split()),
                "line": t["line"],
                "done": t["done"],
            })
    return out

cmd = sys.argv[1]
if cmd == "next":  # apply.json parked.txt [only]
    d, p = load(sys.argv[2]), parked(sys.argv[3])
    only = sys.argv[4] if len(sys.argv) > 4 else ""
    for t in tasks(d):
        if t["done"] or t["label"] in p or (only and t["label"] != only):
            continue
        print("\t".join([t["label"], str(t["line"]), t["text"]]))
        break
elif cmd == "unlabeled":  # apply.json
    for t in load(sys.argv[2])["tasks"]:
        if not t["done"] and not re.match(r"\d+\.\d+\s", t["description"]):
            print(t["description"][:80])
elif cmd == "epic-remaining":  # apply.json parked.txt epic
    d, p = load(sys.argv[2]), parked(sys.argv[3])
    print(sum(1 for t in tasks(d) if t["epic"] == sys.argv[4] and not t["done"] and t["label"] not in p))
elif cmd == "epic-tasks":  # apply.json parked.txt epic
    d, p = load(sys.argv[2]), parked(sys.argv[3])
    for t in tasks(d):
        if t["epic"] == sys.argv[4]:
            mark = "x" if t["done"] else ("parked" if t["label"] in p else " ")
            print("- [%s] %s %s" % (mark, t["label"], t["text"]))
elif cmd == "progress":
    d = load(sys.argv[2])
    print("%d/%d" % (d["progress"]["complete"], d["progress"]["total"]))
elif cmd == "context":
    d = load(sys.argv[2])
    root = d.get("root")
    root = root.get("path", "") if isinstance(root, dict) else (root or "")
    for kind, files in d["contextFiles"].items():
        if kind == "tasks":
            continue
        for f in files:
            print("%s\t%s" % (kind, f.replace(root + "/", "") if root and f.startswith(root + "/") else f))
elif cmd == "tick":  # tasks.md label
    path, label = sys.argv[2], sys.argv[3]
    lines = open(path).read().split("\n")
    prefix = "- [ ] " + label + " "
    hits = [i for i, l in enumerate(lines) if l.startswith(prefix)]
    if len(hits) != 1:
        sys.exit(1)
    lines[hits[0]] = lines[hits[0]].replace("- [ ] ", "- [x] ", 1)
    open(path, "w").write("\n".join(lines))
PY
tp() { python3 -I -c "$TASKS_PY" "$@"; }

refresh_apply() { openspec instructions apply --change "$CHANGE" --json > "$APPLY"; }

# Last value of a "FIELD: value" line in a run's output, tolerant of markdown decoration.
field() { # file FIELD
  FIELD="$2" perl -ne 'if (/^[\s>*`\-]*\**$ENV{FIELD}\**:\s*\**\s*(.*?)\s*\**\s*$/) { $v = $1 } END { print $v // "" }' "$1"
}
fields() { # file FIELD  -> every value, one per line
  FIELD="$2" perl -ne 'print "$1\n" if /^[\s>*`\-]*\**$ENV{FIELD}\**:\s*\**\s*(.+?)\s*\**\s*$/' "$1" | awk '!seen[$0]++'
}
first_word() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -E 's/^[^a-z]*([a-z]+).*/\1/'; }

# Text between "BLOCKING:" and "NON-BLOCKING:" (or "COVERAGE:") of the last verdict block.
blocking_block() {
  perl -ne '
    if (/^[\s>*`\-]*\**BLOCKING\**:/) { $in = 1; @buf = (); next }
    if ($in && /^[\s>*`\-]*\**(NON-BLOCKING|COVERAGE|VERDICT)\**:/) { $in = 0; $out = join("", @buf); next }
    push @buf, $_ if $in;
    END { $out = join("", @buf) if $in; print $out // "" }' "$1"
}

oc_run() { # agent model title promptfile outfile timeout ; returns opencode exit code
  local agent="$1" model="$2" title="$3" pfile="$4" out="$5" tmo="$6" rc=0
  local args=(run --standalone --auto --agent "$agent" --title "$title")
  [ -n "$model" ] && args+=(--model "$model")
  set +e
  perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$tmo" "$OC_BIN" "${args[@]}" "$(cat "$pfile")" </dev/null 2>&1 \
    | perl -pe 's/\e\[[0-9;?]*[A-Za-z]//g' | tee "$out" | tee -a "$STATE/run.log"
  rc=${PIPESTATUS[0]}
  set -e
  [ "$rc" -eq 142 ] && echo "[timeout after ${tmo}s]" | tee -a "$out" >/dev/null
  return "$rc"
}

# Restore anything the model changed in protected paths. The tree was clean before the run.
guard_protected() {
  local dirty_paths
  dirty_paths="$(git status --porcelain -- "${PROTECTED[@]}" "$NOISE")"
  if [ -n "$dirty_paths" ]; then
    note WARN "protected paths changed during a run; reverted: $(printf '%s' "$dirty_paths" | tr '\n' ' ')"
    git checkout -q -- "${PROTECTED[@]}" "$NOISE" 2>/dev/null || true
    git clean -fdq -- "${PROTECTED[@]}" "$NOISE" 2>/dev/null || true
  fi
}

autoformat() { # prettier only on files this task touched, never on openspec/
  local files
  files="$(git ls-files -m -o --exclude-standard -- . "$NOISE" | grep -E '\.(ts|tsx|js|mjs|json|css|md|yml|yaml)$' | grep -v '^openspec/' || true)"
  [ -z "$files" ] && return 0
  printf '%s\n' "$files" | while IFS= read -r f; do [ -f "$f" ] && printf '%s\0' "$f"; done \
    | xargs -0 pnpm exec prettier --write >/dev/null 2>&1 || true
}

run_gate() { # -> $STATE/gate.out ; 0 when every step passes
  : > "$STATE/gate.out"
  local step
  while IFS= read -r step; do
    [ -z "$step" ] && continue
    printf '$ %s\n' "$step" >> "$STATE/gate.out"
    if ! bash -c "$step" >> "$STATE/gate.out" 2>&1; then
      printf 'FAILED: %s\n' "$step" >> "$STATE/gate.out"
      return 1
    fi
  done <<< "$GATE"
}
gate_tail() { tail -n 80 "$STATE/gate.out" | tail -c 9000; }

park() { # label reason
  local label="$1" reason
  reason="$(printf '%s' "$2" | tr '\n|' '  ' | cut -c1-300)"
  printf '%s|%s\n' "$label" "$reason" >> "$PARKED"
  note PARKED "$label: $reason"
  if [ -n "$(dirty)" ]; then
    git stash push -u -q -m "opencode-loop parked $CHANGE $label" -- . "$NOISE" \
      && note INFO "$label: partial work saved in git stash 'opencode-loop parked $CHANGE $label'"
  fi
}

# --- prompts -----------------------------------------------------------------

context_block() {
  echo "Change: $CHANGE (openspec/changes/$CHANGE/)"
  tp context "$APPLY" | while IFS=$'\t' read -r kind path; do echo "- $kind: $path"; done
  echo "- tasks: $TASKS_FILE (read-only for you; the driver ticks it)"
}

implementer_prompt() { # label line text epic feedback outfile
  local label="$1" line="$2" text="$3" epic="$4" feedback="$5" out="$6"
  {
    if [ "$line" = "0" ]; then
      echo "Apply review fixes for the OpenSpec change '$CHANGE', epic $epic. Only the findings below; no new features."
      echo
      echo "SCOPE: $text"
    else
      echo "Implement task $label of the OpenSpec change '$CHANGE' (tasks.md line $line). Only this task."
      echo
      echo "TASK $label: $text"
    fi
    echo
    context_block
    echo
    echo "Tasks in epic $epic (earlier ticked ones are already implemented in the working tree):"
    tp epic-tasks "$APPLY" "$PARKED" "$epic"
    if [ -n "$feedback" ]; then
      echo
      echo "== Feedback from the previous attempt =="
      printf '%s\n' "$feedback"
      echo "Fix exactly this. The working tree already contains the previous attempt's changes."
    fi
    echo
    echo "Finish with the RESULT/SUMMARY/FILES/VERIFIED/DECISION/REASON block."
  } > "$out"
}

verifier_prompt() { # name range epic outfile
  local name="$1" range="$2" epic="$3" out="$4"
  {
    echo "Verify the finished work for review '$name' of the OpenSpec change '$CHANGE'. Read-only, one pass."
    echo
    echo "Diff to review: git diff $range   (and: git log --stat $range)"
    echo
    context_block
    echo
    echo "Tasks in epic $epic (ticked = claimed done by the implementer; parked = not done):"
    tp epic-tasks "$APPLY" "$PARKED" "$epic"
    if [ -s "$STATE/reviews/epic-$epic.notes" ]; then
      echo
      echo "Driver notes:"
      cat "$STATE/reviews/epic-$epic.notes"
    fi
    echo
    echo "Check the scenarios of the specs that these tasks cover. Finish with the VERDICT/BLOCKING/NON-BLOCKING/COVERAGE block."
  } > "$out"
}

# --- git ---------------------------------------------------------------------

commit_task() { # message
  git add -A -- . "$NOISE"
  local secret
  secret="$(git diff --cached --name-only | grep -E '(^|/)\.env($|\.)|\.(pem|key)$' | grep -v '\.env\.example$' || true)"
  if [ -n "$secret" ]; then
    git reset -q
    note WARN "refusing to commit secret-looking files: $(printf '%s' "$secret" | tr '\n' ' ')"
    return 1
  fi
  git commit -q -m "$1" || return 1
  [ -z "$(dirty)" ]
}

# --- verification ------------------------------------------------------------

verify_range() { # name range epic
  local name="$1" range="$2" epic="$3" pf out verdict block
  pf="$STATE/runs/verify-$name.prompt.md"
  out="$STATE/reviews/$name.md"
  verifier_prompt "$name" "$range" "$epic" "$pf"
  note INFO "verifying $name ($range)"
  oc_run loop-verifier "$OC_VERIFY_MODEL" "$CHANGE verify $name" "$pf" "$out" "$VERIFY_TIMEOUT" || true
  if [ -n "$(dirty)" ]; then
    note WARN "verifier modified files; saved in a stash and removed"
    git stash push -u -q -m "opencode-loop verifier wrote files $CHANGE $name" -- . "$NOISE" || true
  fi
  verdict="$(first_word "$(field "$out" VERDICT)")"
  case "$verdict" in
    pass) note REVIEW "$name: pass ($out)"; return 0 ;;
    fail) ;;
    *) note REVIEW "$name: no verdict, see $out"; return 0 ;;
  esac
  block="$(blocking_block "$out")"
  if [ -z "$(printf '%s' "$block" | tr -d '[:space:]-')" ] || printf '%s' "$block" | grep -qi '^[[:space:]-]*none[[:space:]]*$'; then
    note REVIEW "$name: fail without blocking items, see $out"; return 0
  fi
  note REVIEW "$name: BLOCKING findings, one fix run ($out)"
  if fix_with_feedback "$epic" "$name" "Independent review found these BLOCKING problems. Fix exactly these:
$block"; then
    note DONE "$name: review fixes committed"
  else
    note NEEDS-HUMAN "$name: review fixes did not pass the checks; see $out"
  fi
}

fix_with_feedback() { # epic name feedback ; implementer run + gate + commit, no re-review
  local epic="$1" name="$2" feedback="$3" pf out result round=0
  while [ "$round" -le "$FIX_ROUNDS" ]; do
    round=$((round + 1))
    pf="$STATE/runs/fix-$name-$round.prompt.md"
    out="$STATE/runs/fix-$name-$round.out"
    implementer_prompt "$epic.fix" 0 "review fixes for epic $epic ($name)" "$epic" "$feedback" "$pf"
    oc_run loop-implementer "$OC_MODEL" "$CHANGE fix $name" "$pf" "$out" "$TASK_TIMEOUT" || true
    guard_protected
    result="$(first_word "$(field "$out" RESULT)")"
    if [ "$result" = "done" ]; then
      autoformat
      if run_gate; then
        commit_task "$CHANGE $epic: review fixes" && return 0
        return 1
      fi
      feedback="Checks failed after your fix:
$(gate_tail)"
    else
      feedback="Your previous run ended with RESULT: ${result:-none}. $(field "$out" REASON)"
    fi
  done
  git stash push -u -q -m "opencode-loop failed review fix $CHANGE $name" -- . "$NOISE" 2>/dev/null || true
  return 1
}

maybe_verify_epic() { # epic
  local epic="$1" first
  [ "$VERIFY" = "epic" ] || return 0
  [ "$(tp epic-remaining "$APPLY" "$PARKED" "$epic")" = "0" ] || return 0
  first="$(git log --reverse -E --grep="^$CHANGE $epic\.[0-9]+:" --format=%H | head -n 1)"
  [ -n "$first" ] || return 0
  verify_range "epic-$epic" "$first^..HEAD" "$epic"
}

# --- one task ----------------------------------------------------------------

process_task() { # label line text ; 0 = closed, 1 = parked
  local label="$1" line="$2" text="$3" epic attempt=0 feedback="" pf out result reason summary
  epic="${label%%.*}"
  while :; do
    attempt=$((attempt + 1))
    pf="$STATE/runs/$label-$attempt.prompt.md"
    out="$STATE/runs/$label-$attempt.out"
    implementer_prompt "$label" "$line" "$text" "$epic" "$feedback" "$pf"
    note INFO "task $label attempt $attempt"
    oc_run loop-implementer "$OC_MODEL" "$CHANGE $label" "$pf" "$out" "$TASK_TIMEOUT" || true
    guard_protected
    result="$(first_word "$(field "$out" RESULT)")"
    reason="$(field "$out" REASON)"

    if [ "$result" = "blocked" ]; then
      park "$label" "blocked: ${reason:-no reason given}"
      note NEEDS-HUMAN "$label: ${reason:-blocked}"
      return 1
    fi

    if [ "$result" = "done" ]; then
      autoformat
      if run_gate; then break; fi
      feedback="The repository checks failed after your run:
$(gate_tail)"
    else
      feedback="Your previous run ended with RESULT: ${result:-none}${reason:+ ($reason)}. Finish the task."
    fi

    if [ "$attempt" -gt "$FIX_ROUNDS" ]; then
      park "$label" "not done after $attempt attempts; last: $(printf '%s' "$feedback" | tail -n 3 | tr '\n' ' ')"
      return 1
    fi
  done

  fields "$out" DECISION | while IFS= read -r d; do note DECISION "$label: $d"; done
  if ! git status --porcelain --untracked-files=all -- . "$NOISE" | grep -Eq '\.(test|spec)\.[tj]sx?$|(^|[ /])(e2e|tests)/'; then
    note WARN "$label: no test files changed"
    echo "- $label changed no test files; check that its stated verification is really covered" >> "$STATE/reviews/epic-$epic.notes"
  fi

  tp tick "$TASKS_FILE" "$label" || { park "$label" "could not tick the checkbox (line changed?)"; return 1; }
  summary="$(field "$out" SUMMARY | tr -d '`' | cut -c1-72)"
  [ -n "$summary" ] || summary="$(printf '%s' "$text" | cut -c1-60)"
  if ! commit_task "$CHANGE $label: $summary"; then
    git checkout -q -- "$TASKS_FILE" 2>/dev/null || true
    park "$label" "commit failed"
    return 1
  fi
  note DONE "$label: $summary ($(git rev-parse --short HEAD))"
  if [ "$VERIFY" = "task" ]; then verify_range "task-$label" "HEAD~1..HEAD" "$epic"; fi
  return 0
}

# --- preflight ---------------------------------------------------------------

preflight() {
  local c
  for c in git openspec pnpm python3 perl "$OC_BIN"; do
    command -v "$c" >/dev/null 2>&1 || { echo "preflight: '$c' not found on PATH" >&2; return 1; }
  done
  openspec validate "$CHANGE" >/dev/null 2>&1 || { echo "preflight: 'openspec validate $CHANGE' fails" >&2; return 1; }
  git check-ignore -q "$STATE/log.md" || { echo "preflight: .opencode-loop/ must be in .gitignore, or loop state would be committed" >&2; return 1; }
  if [ -n "$(dirty)" ]; then
    echo "preflight: working tree is not clean. Commit or stash first:" >&2
    git status --short >&2
    return 1
  fi
  if [ "$(git branch --show-current)" != "$BRANCH" ]; then
    if git show-ref --verify --quiet "refs/heads/$BRANCH"; then git checkout -q "$BRANCH"; else git checkout -q -b "$BRANCH"; fi
    note INFO "working on branch $BRANCH"
  fi
  [ -d node_modules ] || pnpm install --frozen-lockfile
  if [ "${SKIP_DB:-0}" != "1" ]; then
    pnpm db:up >/dev/null 2>&1 || { echo "preflight: 'pnpm db:up' failed (is Docker running? SKIP_DB=1 to skip)" >&2; return 1; }
  fi
  if [ "${SKIP_BASELINE:-0}" != "1" ]; then
    echo "preflight: running the checks on the starting commit"
    if ! run_gate; then
      echo "preflight: the checks already fail before any task runs, so every task would be blamed. Fix first (SKIP_BASELINE=1 to ignore):" >&2
      gate_tail >&2
      return 1
    fi
  fi
}

summary() {
  echo
  echo "=== $CHANGE: $(tp progress "$APPLY" 2>/dev/null || echo '?') tasks complete ==="
  local tag
  for tag in DONE PARKED NEEDS-HUMAN DECISION REVIEW WARN; do
    grep -F " | $tag | " "$LOG" | sed -E "s/^[^|]*\| //" | sed "s/^/  /" || true
  done
  echo "  log: $LOG   reviews: $STATE/reviews/"
}

finish() { # reason
  echo "stop: $1" > "$STATE/STATUS"
  refresh_apply 2>/dev/null || true
  summary
  echo "stopping: $1"
}

# --- main --------------------------------------------------------------------

if [ -n "${UNPARK:-}" ]; then
  grep -v "^${UNPARK}|" "$PARKED" > "$PARKED.tmp" || true
  mv "$PARKED.tmp" "$PARKED"
  note INFO "unparked $UNPARK"
fi

refresh_apply
unlabeled="$(tp unlabeled "$APPLY")"
if [ -n "$unlabeled" ]; then
  echo "warning: tasks without an 'N.M' label are skipped:"
  echo "$unlabeled"
fi

if [ "$DRY_RUN" = "1" ]; then
  next="$(tp next "$APPLY" "$PARKED" "$ONLY")"
  if [ -z "$next" ]; then echo "dry run: no pending task"; exit 0; fi
  IFS=$'\t' read -r label line text <<< "$next"
  implementer_prompt "$label" "$line" "$text" "${label%%.*}" "" "$STATE/runs/dry-run.prompt.md"
  echo "dry run: next task is $label (progress $(tp progress "$APPLY"))"
  echo "--- prompt ($STATE/runs/dry-run.prompt.md) ---"
  cat "$STATE/runs/dry-run.prompt.md"
  exit 0
fi

if [ -f "$STATE/lock.pid" ] && kill -0 "$(cat "$STATE/lock.pid")" 2>/dev/null; then
  echo "another loop is running for $CHANGE (pid $(cat "$STATE/lock.pid"))" >&2
  exit 1
fi
echo $$ > "$STATE/lock.pid"
trap 'rm -f "$STATE/lock.pid"' EXIT
trap 'finish "interrupted; the working tree may hold a half-finished task, check git status"; exit 130' INT TERM

preflight || exit 1
echo "continue" > "$STATE/STATUS"

parked_in_a_row=0
for ((i = 1; i <= MAX; i++)); do
  refresh_apply
  next="$(tp next "$APPLY" "$PARKED" "$ONLY")"
  if [ -z "$next" ]; then
    if openspec validate "$CHANGE" >/dev/null 2>&1; then note INFO "openspec validate $CHANGE: ok"; else note WARN "openspec validate $CHANGE fails"; fi
    if [ -z "$ONLY" ] && ! run_gate; then note WARN "final checks fail; see $STATE/gate.out"; fi
    finish "no pending tasks (done or parked)"
    exit 0
  fi
  IFS=$'\t' read -r label line text <<< "$next"

  if [ -n "$(dirty)" ]; then
    finish "working tree changed outside the loop"
    git status --short >&2
    exit 1
  fi

  echo
  echo "=== $CHANGE iteration $i/$MAX task $label $(date '+%F %T') ==="
  if process_task "$label" "$line" "$text"; then
    parked_in_a_row=0
    refresh_apply
    maybe_verify_epic "${label%%.*}"
  else
    parked_in_a_row=$((parked_in_a_row + 1))
    refresh_apply
    maybe_verify_epic "${label%%.*}"
    if [ "$parked_in_a_row" -ge "$PARK_LIMIT" ]; then
      finish "$PARK_LIMIT tasks parked in a row"
      exit 0
    fi
  fi
  [ -n "$ONLY" ] && { finish "ONLY=$ONLY done"; exit 0; }
done

finish "reached max iterations ($MAX)"

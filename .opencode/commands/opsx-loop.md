---
description: "Run the implement-and-verify loop over an OpenSpec change's tasks (opencode, background)"
---

Run the implementation and verification loop for an OpenSpec change. The loop is `scripts/opencode-loop.sh`: it takes the unchecked tasks of the change in order, has a fresh `loop-implementer` opencode session build each one, runs the repository checks itself, ticks the box and commits, and has a read-only `loop-verifier` session check each finished epic against the specs. Blocked or failing tasks are parked, never forced. Nothing is pushed.

You only launch and report on it. Do NOT implement tasks yourself, tick checkboxes, edit anything under `openspec/`, commit, or stash.

**Input**: `$ARGUMENTS`, one of:

- `<change> [max-iterations]`: start the loop (default max is 60).
- `status <change>`: report progress, no side effects.
- `stop <change>`: stop a running loop.

If no change name is given, run `openspec list --json` and ask which change to use. If the name is not an active change, say so and stop.

**Start**

1. Confirm the change: `openspec validate <change>`. Stop on failure and show why.
2. Confirm the working tree is clean (`git status --porcelain`, ignoring `.opencode/opencode-loop/loop.log`). If it is not, list the files and tell the user to commit or stash first. Do not do it for them.
3. Check no loop is running: if `.opencode-loop/<change>/lock.pid` holds a live pid (`kill -0`), report it and stop.
4. Preview: run `DRY_RUN=1 scripts/opencode-loop.sh <change>` and show the progress line and the next task label and text (not the whole prompt).
5. Launch as a background process so this session is not blocked, appending to a launch log:
   `nohup scripts/opencode-loop.sh <change> [max-iterations] > .opencode-loop/<change>/launch.log 2>&1 &`
   Pass through only the environment the user named in `$ARGUMENTS` (for example `OC_MODEL=lmstudio/qwen3-coder-30b-a3b-instruct-mlx`, `OC_VERIFY_MODEL=...`, `VERIFY=off|task|epic`). Do not invent values.
6. Wait a few seconds, then show the first lines of the launch log. If preflight failed (dirty tree, failing baseline checks, Docker not running), report the message and stop.

Then tell the user how to follow it:

- Live output: `tail -f .opencode-loop/<change>/run.log`
- Progress and decisions: `.opencode-loop/<change>/log.md`, and `.opencode-loop/<change>/STATUS` (`continue` or `stop: <reason>`)
- Work so far: `git log --oneline` on branch `loop/<change>`
- Epic reviews: `.opencode-loop/<change>/reviews/`
- Stop it: `/opsx-loop stop <change>`

**Status**

Read `.opencode-loop/<change>/STATUS`, the lock pid (running or not), the progress from `openspec instructions apply --change <change> --json` (complete/total and next task), `parked.txt`, and the DONE, PARKED, NEEDS-HUMAN, DECISION, REVIEW and WARN lines of `log.md`. Summarize: running or stopped, progress, what is parked and why, what needs a human, open review findings. Do not change anything.

**Stop**

Read the pid from `.opencode-loop/<change>/lock.pid`, confirm it is a live `opencode-loop.sh` process (`ps -p <pid> -o command=`), send it `SIGTERM`, then show `STATUS`. If the working tree is then dirty, say that the interrupted task left changes and the user should inspect `git status` (do not revert them).

**Guardrails**

- One loop per change at a time; the script enforces it with the lock.
- Parked tasks stay parked until the user fixes the cause (often a spec question: use `/opsx-update`) and restarts with `UNPARK=<label>`.
- The loop never edits specs. A task that needs a spec change is parked with the reason.
- The result is a branch `loop/<change>` of commits for the user to review and merge. Offer `/opsx-archive` only after the user has reviewed it.

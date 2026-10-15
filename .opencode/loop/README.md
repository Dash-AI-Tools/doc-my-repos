# Implement-and-verify loop (opencode)

Runs the unchecked tasks of one OpenSpec change to completion, with checks and an independent review. Start it with `/opsx-loop <change>` in opencode, `/opsx:loop <change>` in Claude Code, or directly:

```bash
scripts/opencode-loop.sh <change> [max-iterations]
DRY_RUN=1 scripts/opencode-loop.sh <change>   # preview the next task and its prompt
```

## What one iteration does

1. The script takes the first unchecked task from `openspec instructions apply --json` (file order, parked tasks skipped).
2. A fresh `loop-implementer` session implements it with its tests and reports a `RESULT` block. Every run is a new session, so context stays small enough for a local model.
3. The script (not the model) autoformats the touched files and runs typecheck, lint, `format:check` and tests. Failures go back to a fresh implementer run, up to `FIX_ROUNDS` times.
4. The script ticks the checkbox and makes one commit: `<change> <task>: <summary>`. No attribution lines, no push.
5. When the last task of an epic closes, one read-only `loop-verifier` session checks the whole epic against the spec scenarios and the `CLAUDE.md` rules. Blocking findings get one fix run and a `<change> <epic>: review fixes` commit. There is no re-review.
6. A task that is blocked, or still failing after the fix rounds, is parked and its partial work goes to a git stash. Three parked in a row stops the loop.

## Files

- `opencode.json`: the `loop-implementer` and `loop-verifier` agents and their permissions. The implementer cannot touch `openspec/`, `.opencode/`, `.claude/`, env files or keys, cannot run git writes or network tools. The verifier cannot edit and may only run read and check commands.
- `.opencode/loop/implementer.md`, `verifier.md`: the agents' instructions.
- `.opencode-loop/<change>/` (git-ignored): `log.md`, `STATUS`, `parked.txt`, `run.log`, `runs/`, `reviews/`.

## Models

`OC_MODEL=provider/model` for the implementer, `OC_VERIFY_MODEL` for the verifier; a stronger verifier is the better use of money. Both default to opencode's configured model.

## Before the first run

The working tree must be clean (commit these loop files first), Docker must be running for the test database (or `SKIP_DB=1`), and the checks must already pass on the starting commit (or `SKIP_BASELINE=1`).

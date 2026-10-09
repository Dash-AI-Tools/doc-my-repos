---
name: dev-loop
description: Run ONE iteration of the DocMyRepos development loop. Picks the next unchecked task in openspec/changes/docmyrepos-mvp/tasks.md, implements it with the task-implementer agent, reviews it with the spec-reviewer agent, ticks it, and reports. Repeat with `/loop /dev-loop` (attended) or `/loop /dev-loop unattended`, or run headless with scripts/dev-loop.sh. Use when the user asks to keep building the repo task by task, including overnight or unattended.
---

# dev-loop

One iteration = one task, strictly sequential. Never do two tasks in one run. An outer driver repeats this skill.

Arguments (any order):
- `unattended`: nobody is watching. Never ask the user anything and never stop for a human. Park problem tasks and keep going (see Unattended mode).
- `headless`: the driver is the shell script, not `/loop`. Never call `ScheduleWakeup`; just write the status file and exit.
- `max=N`: stop after N iterations in total (default 40 when unattended).
- `normal`: turn off caveman style (see Output style).

Without `unattended`, follow Attended mode.

## Output style: caveman ultra

Unless `normal` is given, run the whole loop in caveman ultra. At the very start of every run, invoke the `caveman` skill with args `ultra`.

- Applies to: your messages, the per-run report, `log.md` entries, and what the subagents report back. Tell both subagents in their prompt: "Report in caveman ultra: terse fragments, no filler. Code, file contents, specs, docs, test names and commit messages stay in normal prose."
- Does NOT apply to: anything written into the repo (code, comments, docs, specs, README, tests), commit messages, or quoted error output.

## Model routing

Before spawning `task-implementer` or `spec-reviewer`, use the `model-router` skill to get `model` and `effort` for the task, role, and attempt number. Pass them as the `model` and `effort` parameters of the Agent call. Default effort is medium, the cap is high. Each failed attempt moves one rung up the router's ladder.

## State files (unattended)

Under `.claude/dev-loop/` (create if missing; never stage or commit them):
- `log.md`: append-only. Sections `## Done`, `## Parked`, `## Decisions`, `## Needs human`. One line per entry, always with the task id.
- `STATUS`: single line, rewritten at the end of every run: `continue` or `stop: <reason>`.

Read `log.md` first on every run. Count iterations from it.

## 1. Pick the task

- Read `openspec/changes/docmyrepos-mvp/tasks.md`. Take the first `- [ ]` line in file order that is not listed under `## Parked` in `log.md`.
- None left: run `openspec validate docmyrepos-mvp`, write the final summary (see Finish), set `STATUS` to `stop: all tasks done or parked`.
- Announce `Task <id>: <text>`.

## 2. Human-gated tasks

These need a real external system or a person: 6.5, 13.3, 14.1, 14.2, and any task that needs a secret or account not already in `.env`. Never invent secrets.

- Attended: stop and say exactly what is needed.
- Unattended: still do the part that needs no external system, via `task-implementer`, with the instruction "build the artifact only, skip the external verification". Examples: write the setup guide for 6.5, the CI workflow file for 13.3. Do NOT tick the box. Add it under `## Needs human` with the verification that is still pending, then move on.

## 3. Implement

Spawn `task-implementer` with the task id and full task text, with the `model` and `effort` from `model-router` (role `implementer`, attempt number). Do not implement in the main thread.

- `STATUS: done` -> step 4.
- `STATUS: failed` -> retry once with the failure output in the prompt. Still failing: Attended: stop and report. Unattended: park it.
- `STATUS: blocked` (open question, missing decision, spec conflict, missing prerequisite): Attended: stop and report. Unattended: park it, with the question in the reason.

## 4. Independent review

Spawn `spec-reviewer` (a different agent, not a continuation) with the task id, text, and the `FILES:` list, with the `model` and `effort` from `model-router` (role `reviewer`). Do not pass the implementer's opinion of its own quality.

- `VERDICT: pass` -> step 5.
- `VERDICT: fail` -> send `FINDINGS` and `MISSING TESTS` to a new `task-implementer` run, then review again. Max 2 fix rounds. Then: Attended: stop and report. Unattended: park it.

## 5. Close the task

- Run the repo checks yourself once: `pnpm typecheck && pnpm lint && pnpm test` (skip any that do not exist yet; task 1.x creates them). If a check fails, treat it like a failed review round.
- All pass: tick the checkbox in `tasks.md` (`- [ ]` -> `- [x]`). Only the main thread ticks. Never tick a task whose verification did not pass.
- If the task changed behavior vs. a spec, never edit the spec silently. Attended: stop and ask the user to run `/opsx:update`. Unattended: keep the change only if the spec still holds; otherwise park the task and log the needed spec change under `## Needs human`.
- Commit (attended and unattended): after the tick, make exactly one commit per closed task, so the tick is in the same commit and `git status` is clean afterwards. Message `<id>: <short task summary>` (for example `5.4: tree fetch with tree-SHA short-circuit`), no Claude/Anthropic attribution, co-author, or "Generated with" lines. Never push, never amend, never force. Stage with `git add -A -- . ':!.claude/dev-loop'`, then confirm `git status --short` prints nothing.
  - Do not commit a task that is parked, failed review, or only partly built (human-gated tasks stay uncommitted-as-done: commit the artifact with message `<id> (partial): <summary>`, box unticked).
  - The maintainer creates the repo, so `.git` already exists. Before the first iteration, if the tree has uncommitted changes you did not make, stop (attended: tell the user; unattended: circuit breaker). Work on branch `loop/docmyrepos-mvp`: create it once from `main` if the current branch is `main`/`master`, and stay on it. The maintainer merges or pushes it.

## Unattended mode

Goal: make as much correct progress as possible and leave a clear trail, without anyone answering questions.

- Never call AskUserQuestion. When a small choice is open, pick the option that matches the specs and `CLAUDE.md`, and log it under `## Decisions` with the task id and reason.
- Parking a task: append to `## Parked`: `<id> | <attempts> | <reason or failing command output summary>`. Revert its uncommitted changes with `git checkout -- . && git clean -fd -- src tests drizzle` only when a git repo exists and nothing else is staged; otherwise leave files and say so in the log. Do not tick it.
- Dependencies: if a parked task is a prerequisite, later tasks that need it will report `blocked`; park them with reason `depends on <id>`. Do not retry them every run.
- Circuit breaker: set `STATUS` to `stop: ...` when any of these holds: 3 tasks parked in a row, the `max=N` limit is reached, `pnpm install` or the dev database cannot start, or the working tree has unexpected changes you did not make.
- No destructive actions: no `git push`, no `git reset --hard`, no `rm -rf` outside build output, no force flags, no editing `.env`, no sending data to external services except package installs and the GitHub API calls the task requires.

## Finish / report

Every run ends with a short block: task id, result (`done` / `parked` / `needs human`), files changed, verification result, reviewer verdict, next task id.

On a `stop:` also print a summary from `log.md`: tasks done this run, parked tasks with reasons, needs-human items, decisions made.

## Loop control

Always rewrite `STATUS` first.

- `headless`: do nothing more. The shell script reads `STATUS`.
- Under `/loop` (not `headless`), more work remains: call `ScheduleWakeup` with `delaySeconds: 60`, the same `/loop` prompt (including the `unattended` argument), `noop: false`.
- `stop:` condition: call `ScheduleWakeup` with `stop: true` and give the reason in plain words.

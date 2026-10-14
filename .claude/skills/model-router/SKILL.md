---
name: model-router
description: Pick the model (haiku, sonnet, or opus) and reasoning effort (medium or high) for a DocMyRepos task, for both the implementer and the reviewer, and escalate on retries. Used by the dev-loop skill before spawning task-implementer or spec-reviewer. Default effort is medium; the cap is high.
---

# model-router

Input: task id and text (from `openspec/changes/docmyrepos-mvp/tasks.md`), the role (`implementer` or `reviewer`), and the attempt number (0 for the first try).

Output: one line, `model=<haiku|sonnet|opus> effort=<medium|high>`. The caller passes these as the `model` and `effort` parameters of the Agent tool. They override the model in the agent's frontmatter.

This skill cannot change the model of the main session (`/model` is a user command). The main thread only orchestrates, so it stays on one model. Routing applies to the subagents, where the work happens.

## Hard limits

- Effort is `medium` unless this skill says `high`. Never `low`, `xhigh`, or `max`.
- Never go above `opus` + `high`.

## 1. Classify the task

Use the table first. Ids not in the table use the rubric.

| Class | Tasks | Start at |
| --- | --- | --- |
| mechanical | 1.4, 1.5, 1.6, 2.3, 13.2 | haiku / medium |
| standard | everything else | sonnet / medium |
| hard | 3.4, 5.2, 5.4, 5.5, 5.7, 5.8, 5.9, 6.3, 10.1, 12.4 | opus / medium |
| critical | 5.6, 6.4, 7.2, 7.5, 9.1, 12.1 | opus / high |
| tricky standard | 7.4, 8.2, 7.7, 4.3 | sonnet / high |

Rubric for ids not in the table:
- **mechanical**: config files, scaffolding from a generator, sample files, templates, a single-file change with a clear recipe, no new logic.
- **hard**: concurrency, caching or token lifetimes, rate limiting, sync diffing, database migrations with generated columns, anything where a mistake corrupts data silently.
- **critical**: the task is a security boundary from `CLAUDE.md` (sanitizing, path validation, signature verification, credential handling, the visibility filter, CSP) or the one place a rule must hold everywhere.
- **tricky standard**: pure logic with many edge cases, or behavior that depends on timing or theme state.
- otherwise **standard**.

If the task text contains an explicit hint like `[model: opus effort: high]`, use it, still within the limits above.

## 2. Role

- `implementer`: the class's start rung.
- `reviewer`: independent of the implementer, and never weaker than `sonnet`.
  - mechanical or standard task -> `sonnet`, same effort as the implementer rung
  - hard or critical task -> `opus`, same effort as the implementer rung

## 3. Escalate on retries

Move one rung up the ladder for each failed attempt (implementer failed, review failed, or checks failed). The ladder for the class continues from its start rung:

```
haiku/medium -> sonnet/medium -> sonnet/high -> opus/high
sonnet/medium -> sonnet/high -> opus/high
opus/medium  -> opus/high
```

Stop at the top rung. A task already at `opus/high` that fails again is parked or reported by the caller, not retried at a higher level.

## 4. Record

Unattended: append the choice to `## Decisions` in `.claude/dev-loop/log.md`, as `<id> | <role> | model=<m> effort=<e> | attempt <n>`.

---
type: Guide
title: Ask the docs
description: How the Ask assistant works. Setting it up as an admin, what is sent to the model provider, how answers are grounded and cited, the limits, the usage records, privacy, reverse proxy settings for streaming, and what it cannot promise.
tags: [guides, ask, ai]
status: stable
sources:
  - src/server/ask/handler.ts
  - src/server/ask/retrieve.ts
  - src/server/ask/prompt.ts
  - src/server/ask/settings.ts
  - src/server/ask/limits.ts
  - src/server/admin/ask.ts
  - src/lib/ask/answer.ts
  - src/lib/ask/sections.ts
  - src/server/config/env.ts
  - src/server/config/schema.ts
  - docmyrepos.config.example.yml
generated: 2026-10-16
verified: 2026-10-16
stale_after: 2999-01-01
---

# Ask the docs

**Ask** lets a signed-in reader type a question in plain language and get an answer written from the synced documentation, with numbered references that open the exact section each claim came from. It is for questions like "how do I rotate the signing key?", where search needs the right keywords and the answer is spread over several pages.

Ask is **off by default**. Nothing about it appears in the portal until an admin turns it on.

## Setting it up

Setting up has two parts, done by two different people, because credentials and endpoints stay with whoever runs the server.

1. **The operator sets credentials in the environment** (see `.env.example`):

   | Variable               | Meaning                                                                                 |
   | ---------------------- | --------------------------------------------------------------------------------------- |
   | `AI_ANTHROPIC_API_KEY` | An Anthropic API key. Enables the `anthropic` provider.                                 |
   | `AI_OPENAI_BASE_URL`   | Base URL of an OpenAI-compatible endpoint, for example `https://models.example.com/v1`. |
   | `AI_OPENAI_API_KEY`    | The key for that endpoint. Optional only when the address is loopback.                  |

   An OpenAI-compatible endpoint covers hosted providers and local servers such as Ollama or vLLM. The base URL must be `https`; plain `http` is accepted only for loopback addresses (`localhost`, `127.x.x.x`, `::1`), where the key may be left out. A value that breaks a rule is reported by variable name on the status page and the admin page, never printed, and that provider is simply unavailable: the rest of the portal starts and works as before.

2. **An admin chooses the provider and model** on **Admin → Ask** (`/admin/ask`): turn Ask on, pick a provider among those the operator has set up, enter the model name, press **Test connection**, and **Save**. The choice is stored in the database and applies to the next question, with no restart. Turning Ask off keeps the saved provider and model.

The page offers no field for a key or an address. An admin can only choose among what the operator provisioned, so nobody with the admin role can send the key to another host. The model name is the one thing the admin types: it is checked (1 to 100 characters, letters, digits and `. _ : / @ + -`) and only ever sent as a body field to the provider.

The **Test connection** button sends one fixed request ("Reply with the single word OK.", at most 8 tokens) with the environment credentials and reports one of `ok`, `rejected`, `not found`, `unavailable` or `timed out`. It never shows provider text, and it does not save. It is limited to 5 per minute.

### Examples

An Anthropic account:

```bash
AI_ANTHROPIC_API_KEY=your-key
```

A hosted OpenAI-compatible provider:

```bash
AI_OPENAI_BASE_URL=https://models.example.com/v1
AI_OPENAI_API_KEY=your-key
```

A model on the same machine (Ollama), no key:

```bash
AI_OPENAI_BASE_URL=http://127.0.0.1:11434/v1
```

## What a reader sees

- An **Ask** link in the header, a **Prefer an answer? Ask instead** link on the search page (the query is filled in, not sent), and **Ask about this repository** on a repository page.
- The Ask page names the provider that receives the question, and the host name when it is an OpenAI-compatible endpoint.
- The answer streams in. **Stop** keeps what was received. Every answer lists its **references**, each a link to the document at the right heading, and the answer cites them with `[1]`, `[2]`.
- **Follow-up questions** work: the last four exchanges travel with each new question. **New conversation** clears them. Reloading the page starts empty.
- A question can be limited to one repository from the Ask page or a repository page.

Without script the page says it needs script. The chat has a labelled field (Enter sends, Shift+Enter adds a line), announces "Answer ready" politely instead of reading every word, and works at every text size and at 320 pixels wide in both themes.

## How an answer is made

1. The model is asked, in a short non-streaming call, to turn the question and the earlier questions into up to three keyword searches. It sees no document text. If that call fails or gives nothing usable, the question's keywords are searched instead.
2. The searches run through the normal full-text search and its single visibility filter, so a reader can only be answered from documents they could open. A blocked repository contributes nothing, and allowing it again brings it back.
3. The best sections of the top documents are cut out: at most 8 sections and 12,000 characters, at most 2 per document.
4. If nothing matched, the page says so and offers the search. **The model is not asked for an answer.**
5. Otherwise the model writes the answer from those numbered excerpts only. If they do not cover the question it says so rather than guess.

## What is sent to the provider

Only the question (at most 2,000 characters), up to four earlier exchanges, and the selected excerpts, labelled as data. Never the reader's email or name, cookies, other documents or any credential. The provider is told the excerpts are untrusted and that it has no tools.

## Safety

Documents come from other people's repositories, so an excerpt may contain instructions aimed at the model. Ask limits what such text can do: excerpts are passed as labelled data inside a block closed by a random per-request marker, the model has no tools and cannot fetch or act, and the answer is rendered by a restricted renderer. Answers show paragraphs, lists, emphasis, inline code and code blocks only. **No images, no HTML and no links from the model's text**: a Markdown image is not loaded, a web address is shown as text, and the only links are the references the server built from stored data. A citation number that matches no excerpt is removed.

This reduces prompt injection to the wording of an answer, which a reader can check against the references. It cannot be made impossible, and answers can be wrong: treat the references as the source of truth.

## Limits

| Limit                                 | Default          | Setting                      |
| ------------------------------------- | ---------------- | ---------------------------- |
| Questions per user per day            | 100              | `ask.questionsPerDay`        |
| Questions per user in ten minutes     | 20               | `ask.questionsPerTenMinutes` |
| Answer length (output tokens)         | 1000             | `ask.maxOutputTokens`        |
| Answers at once in one server process | 8                | `ask.maxConcurrent`          |
| Question length                       | 2,000 characters | fixed                        |
| One answer at a time per user         | yes              | fixed                        |
| Time for one answer                   | 60 seconds       | fixed                        |

All four settings are in the `ask` block of `docmyrepos.config.yml` (see [Configuration](./configuration.md)). There is no `enabled` key there: on and off is the admin's choice. A user over a limit gets a message with the time they can ask again (`429` with `Retry-After`); a busy server answers `503`. Questions that are refused, or find no documents, do not count. The one-at-a-time rule is kept per server process, so a second instance could allow two; the daily and ten-minute limits are counted in the database and hold across instances.

## Usage records and privacy

For each question accepted for the model the database keeps one row: the user, the time, the provider, input and output token counts as the provider reported them (or an estimate, marked in the outcome), the number of excerpts and how it ended. **No question, answer or excerpt is stored**, and logs carry ids, counts and fixed error kinds only. Rows older than 90 days are removed. The conversation lives in the browser tab and is gone when it closes.

Question and excerpts do leave your server for the provider you chose. Choose a local model if that must not happen.

## Behind a reverse proxy

The answer streams as server-sent events from `POST /api/ask`. The response carries `Cache-Control: no-store` and `X-Accel-Buffering: no`; in nginx also set `proxy_buffering off;` for this path and keep `proxy_read_timeout` above 60 seconds. A proxy that buffers the response shows the answer all at once, or not before it ends. Per-client rate limiting still belongs in the proxy.

## Failures

A provider that is down, rejects the key, is slow or sends something unexpected gives the reader a short fixed message and a **Try again** button, never provider text, a URL or a key. If an admin's saved choice loses its credentials (the operator removes the variable), Ask hides itself and `/ask` answers 404; the admin page and `/status` say which variable is missing, and the rest of the portal keeps working.

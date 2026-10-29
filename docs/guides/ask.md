---
type: Guide
title: Ask the docs
description: How the Ask assistant works. Setting it up as an admin, what is sent to the model provider, how answers are grounded and cited, the limits, the usage records, privacy, reverse proxy settings for streaming, and what it cannot promise.
tags: [guides, ask, ai]
status: stable
sources:
  - packages/server/src/ask/handler.ts
  - packages/server/src/ask/retrieve.ts
  - packages/server/src/ask/prompt.ts
  - packages/server/src/ask/settings.ts
  - packages/server/src/ask/limits.ts
  - packages/server/src/public-access/settings.ts
  - packages/server/src/admin/ask.ts
  - packages/core/src/ask/answer.ts
  - packages/core/src/ask/sections.ts
  - packages/server/src/ask/credentials.ts
  - packages/server/src/settings/store.ts
  - packages/core/src/config/schema.ts
generated: 2026-10-16
verified: 2026-10-16
stale_after: 2999-01-01
---

# Ask the docs

**Ask** lets a signed-in reader type a question in plain language and get an answer written from the synced documentation, with numbered references that open the exact section each claim came from. It is for questions like "how do I rotate the signing key?", where search needs the right keywords and the answer is spread over several pages.

Ask is **off by default**. Nothing about it appears in the portal until an admin turns it on.

## Setting it up

An **admin** does all of it on the **Ask** tab of **Admin > Workspace configuration** (`/admin/workspace?tab=ask`); nothing is set in the server environment except `SETTINGS_ENCRYPTION_KEY`, which encrypts the keys (see [Configuration](./configuration.md#secrets)).

1. **Enter the credentials** under _Credentials_:

   | Field                      | Meaning                                                                                 |
   | -------------------------- | --------------------------------------------------------------------------------------- |
   | Anthropic API key          | An Anthropic API key. Makes the `anthropic` provider available.                         |
   | OpenAI-compatible base URL | Base URL of an OpenAI-compatible endpoint, for example `https://models.example.com/v1`. |
   | OpenAI-compatible API key  | The key for that endpoint. May be left out only when the address is loopback.           |

   An OpenAI-compatible endpoint covers hosted providers and local servers such as Ollama or vLLM. The base URL must be `https`; plain `http` is accepted only for loopback addresses (`localhost`, `127.x.x.x`, `::1`), where the key may be left out. A value that breaks a rule is refused when you save it, with the field named. Keys are **write-only**: after saving, the page shows only that a key is set and when it changed, never the key.

2. **Choose the provider and model**: turn Ask on, pick a provider whose credentials are entered, type the model name, press **Test connection**, and **Save**. It applies to the next question, with no restart. Turning Ask off keeps the saved provider, model and credentials.

The model name is checked (1 to 100 characters, letters, digits and `. _ : / @ + -`) and only ever sent as a body field to the provider. The credentials are stored encrypted, only an admin can read or change them, and each change is recorded (who and which field, never the value).

The **Test connection** button sends one fixed request ("Reply with the single word OK.", at most 8 tokens) with the stored credentials and reports one of `ok`, `rejected`, `not found`, `unavailable` or `timed out`. It never shows provider text, and it does not save. It is limited to 5 per minute.

### Examples

An Anthropic account: enter the key under _Anthropic API key_.

A hosted OpenAI-compatible provider: base URL `https://models.example.com/v1` and its key.

DeepSeek: base URL `https://api.deepseek.com/v1`, its API key, and a model name such as `deepseek-chat` or `deepseek-reasoner`. Choose _OpenAI-compatible endpoint_ as the provider.

A model on the same machine (Ollama), no key: base URL `http://127.0.0.1:11434/v1`.

## What a reader sees

- A floating **Ask** button at the bottom right of every page, which opens the chat in a panel (the panel's full-page button opens the same chat at `/ask`); an **Ask** link in the header, a **Prefer an answer? Ask instead** link on the search page (the query is filled in, not sent), and **Ask about this repository** on a repository page.
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

## Visitors without an account

Ask is for signed-in users unless an admin turns on **Allow Ask the docs** under **Public access** on the Repository access tab (see [Public access](configuration.md#public-access)). It is off by default and needs two other things: Ask itself turned on with a provider, and at least one public repository.

- **What they can ask about.** Only public repositories. Retrieval goes through the same single visibility filter as everything else, so an excerpt of any other repository never reaches the model or the references, and a question about one is answered "the documentation does not cover it".
- **Shared caps.** An anonymous visitor has no account to count against, so the questions per day (200 by default, 1 to 10000) and per ten minutes (20, 1 to 1000) are shared by all of them together, next to the cap on answers at once. A question over a cap gets `429` with `Retry-After` and a short fixed message; signed-in users' own limits are separate and unaffected. A question that finds no documents still counts, because the search query is itself a model call you pay for.
- **What is stored.** One row per question in the usage table, marked anonymous, holding the provider, token counts and how it ended. No question, answer, excerpt, address or identifier of the visitor is stored or logged.
- **A shared budget.** Anyone who can reach the portal can spend it, up to the caps. Leave the switch off unless you want that, and set the caps to what you are willing to pay for.

## Safety

Documents come from other people's repositories, so an excerpt may contain instructions aimed at the model. Ask limits what such text can do: excerpts are passed as labelled data inside a block closed by a random per-request marker, the model has no tools and cannot fetch or act, and the answer is rendered by a restricted renderer. Answers show paragraphs, lists, emphasis, inline code and code blocks only. **No images, no HTML and no links from the model's text**: a Markdown image is not loaded, a web address is shown as text, and the only links are the references the server built from stored data. A citation number that matches no excerpt is removed.

This reduces prompt injection to the wording of an answer, which a reader can check against the references. It cannot be made impossible, and answers can be wrong: treat the references as the source of truth.

## Limits

| Limit                                 | Default          | Setting                       |
| ------------------------------------- | ---------------- | ----------------------------- |
| Questions per user per day            | 100              | Ask limits: questions per day |
| Questions per user in ten minutes     | 20               | Ask limits: ten minutes       |
| Answer length (output tokens)         | 1000             | Ask limits: answer length     |
| Answers at once in one server process | 8                | Ask limits: answers at once   |
| Question length                       | 2,000 characters | fixed                         |
| One answer at a time per user         | yes              | fixed                         |
| Time for one answer                   | 60 seconds       | fixed                         |

The four settings are under _Ask limits_ on **Admin > Workspace configuration** (see [Configuration](./configuration.md)). Whether Ask is on is set on the Ask page. A user over a limit gets a message with the time they can ask again (`429` with `Retry-After`); a busy server answers `503`. Questions that are refused, or find no documents, do not count. The one-at-a-time rule is kept per server process, so a second instance could allow two; the daily and ten-minute limits are counted in the database and hold across instances.

## Usage records and privacy

For each question accepted for the model the database keeps one row: the user, the time, the provider, input and output token counts as the provider reported them (or an estimate, marked in the outcome), the number of excerpts and how it ended. **No question, answer or excerpt is stored**, and logs carry ids, counts and fixed error kinds only. Rows older than 90 days are removed. The conversation lives in the browser tab and is gone when it closes.

Question and excerpts do leave your server for the provider you chose. Choose a local model if that must not happen.

## Behind a reverse proxy

The answer streams as server-sent events from `POST /api/ask`. The response carries `Cache-Control: no-store` and `X-Accel-Buffering: no`; in nginx also set `proxy_buffering off;` for this path and keep `proxy_read_timeout` above 60 seconds. A proxy that buffers the response shows the answer all at once, or not before it ends. Per-client rate limiting still belongs in the proxy.

## Failures

A provider that is down, rejects the key, is slow or sends something unexpected gives the reader a short fixed message and a **Try again** button, never provider text, a URL or a key. If an admin's saved choice loses its credentials (a key is cleared, or the encryption key changed so it cannot be read), Ask hides itself at once and `/ask` answers 404; the admin page and `/status` say which setting is missing, and the rest of the portal keeps working.

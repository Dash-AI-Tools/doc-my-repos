# Proposal

## Why

Search finds documents; it does not answer questions. A person who asks "how do I rotate the signing key?" has to guess keywords, open several results and read them. An AI assistant that reads the relevant sections of the synced docs and answers in plain language, with references to the exact pages, shortens that to one step, and the references keep it honest: every claim can be checked at its source. It must only use what the signed-in user is allowed to read, and never invent an answer the docs do not support.

## What Changes

- **An "Ask" page** (`/ask`) with a chat: the user types a question, the answer streams in, and every answer lists **references**: the documents and sections it was drawn from, each a link that opens the page at the right heading. Follow-up questions keep the conversation's context. The user can scope a question to one repository (`/ask?repo=owner/name`) and reach Ask from the header, from the search page ("Ask instead") and from a repository page.
- **Grounded answers only.** The assistant answers from excerpts of the portal's documents and says plainly when the docs do not cover the question, instead of guessing. It cites its sources with numbered markers that link to the references. A question with no matching documents never reaches the model.
- **Retrieval reuses search.** The server turns the question (and recent turns) into search queries, runs them through the existing full-text search and the single visibility filter, cuts the best sections out of the top documents, and gives only those to the model. No embeddings, no vector database, no new infrastructure in this change.
- **Admins set up the provider and model.** An admin page (`/admin/ask`) lets an organization's administrators turn Ask on, choose the provider (Anthropic, or an OpenAI-compatible endpoint, which covers hosted providers and local servers such as Ollama or vLLM) and enter the model name, with a Test button that checks the connection. The choice is stored in the database and takes effect on the next question, with no redeploy. The **operator** still provides the credentials and endpoint in the environment (`AI_ANTHROPIC_API_KEY`; `AI_OPENAI_BASE_URL` and optional `AI_OPENAI_API_KEY`), so keys never pass through the browser or the database and an admin cannot redirect them to another host. The feature is **off by default** and shows nothing until an admin turns it on. The Ask page says which provider receives the question and the excerpts.
- **Safe with untrusted docs.** Document text is passed as labelled data with no tools for the model to call, so there is nothing for an injected instruction to act on. The answer is rendered through a restricted renderer: no images, no HTML, and links only to the portal's own references, so an answer cannot leak data through a URL.
- **Cost and abuse limits.** A per-user daily question limit and a short-term rate limit, a cap on concurrent requests, bounded input and output sizes, and a usage record (counts and token numbers, never the text).
- **Private by design.** Conversations live in the browser tab only. The server stores no questions and no answers; the usage record holds user, time, token counts and outcome. Logs carry the same.
- Not changed: search, sync, the document page, roles and repository access, the MCP server. Not included: embeddings or semantic search, conversation history or sharing, answers that write or change anything, uploading files, feedback buttons, a floating chat widget on every page, voice, and multiple providers at once.

## Capabilities

### New Capabilities

- `ask-docs`: asking questions, grounded and cited answers, follow-ups, repository scoping, what the model may see, rendering of answers, the page and its accessibility, and where the entry points are.
- `ai-provider-config`: admin setup of the on/off switch, provider and model (with a connection test), operator-provided credentials, what is sent where, limits, usage records, and the rules that keep keys and content out of logs.

### Modified Capabilities

- None. Search, visibility and the document page are specified in the `docmyrepos-mvp` change specs, which are not yet archived into `openspec/specs/`. Ask reuses them and adds new behavior; it does not rewrite their requirements.

## Impact

- Data: a small `ask_usage` table (user, time, input and output tokens, outcome, provider) and a single-row `ask_settings` table (enabled, provider, model), in one Drizzle migration; no content is stored.
- Dependencies: none. Providers are called with `fetch` and their streams are parsed by small adapters, so no AI SDK is added.
- Server: new `src/server/ask/` (retrieval, section selection, prompt building, provider adapters, streaming handler, limits) and a route `POST /api/ask` (server-sent events); new reads go through `src/server/queries/` and are registered in `QUERY_FUNCTIONS`; pure helpers in `src/lib/ask/` (section splitting and scoring, citation checking, answer sanitizing).
- Config: an `ask` block in `docmyrepos.config.yml` for limits only, and optional environment variables `AI_ANTHROPIC_API_KEY`, `AI_OPENAI_BASE_URL` and `AI_OPENAI_API_KEY`, validated at startup, with keys secrets that never appear in logs, errors, responses or the admin page.
- Admin: a new `/admin/ask` page and `GET`/`PUT /api/admin/ask` and `POST /api/admin/ask/test`, behind the existing admin guard.
- Network: the server now makes outbound requests to the configured provider when Ask is enabled. The browser still talks only to the portal (the CSP is unchanged). The README and the Ask page state the data flow.
- UI: `/ask` page and client chat island, header link, entry points on the search and repository pages, text-size and read-mode compatible, both themes.
- Coordination: edits the header, search page and repository page, which other changes also touch; each task re-reads the files first. It uses `comments`-style text-only rendering rules and the branding name if present.
- Tests: unit tests for retrieval, section scoring, prompt building, citation checking and answer sanitizing; adapter tests against fake provider servers (including malformed and slow streams); query and enforcement tests; route tests for auth, limits and errors; component tests; e2e with a fake provider; an injection and exfiltration test set.
- Docs: `README.md` (setup, providers, what is sent, limits, privacy) and a `docs/guides/` page.

## Assumptions

- "AI chat" is read as a question-and-answer assistant grounded in the portal's docs, not a general chatbot, and not an assistant with actions.
- "Orgs should be able to set up the provider and model" is read as: the organization's administrators choose them in the admin UI, without redeploying. Credentials and endpoints stay with the operator in the environment (project rule: secrets only from environment variables), so the admin chooses among the providers the operator has provisioned. Two adapters ship: Anthropic and OpenAI-compatible. The admin supplies the model name; none is hard-coded or suggested.
- Retrieval is keyword-based (the existing full-text search, driven by model-written queries). Semantic search with embeddings is a possible follow-up if keyword retrieval proves too weak.
- Everyone who can read the portal can use Ask when it is enabled; there is no separate permission.

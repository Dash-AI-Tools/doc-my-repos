---
okf_version: "0.2"
title: DocMyRepos documentation
description: The documentation of DocMyRepos, written as an OKF bundle. DocMyRepos syncs this folder into its own portal, so what you read here is also the dogfood test.
generated: 2026-10-10
---

# DocMyRepos documentation

DocMyRepos syncs the `docs/` folders of your GitHub repositories into Postgres and serves them as a searchable portal. This folder documents DocMyRepos itself. It is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) (OKF v0.2) bundle, so when DocMyRepos is pointed at its own repository you get an OKF space with type filters. The repository's [README](../README.md) has the product overview and the quickstart.

## Where to start

- New to the project: [Getting started](./guides/getting-started.md), then [Configuration](./guides/configuration.md).
- Installing with one command: [Install with the script](./guides/install-script.md).
- Writing OKF documents with an AI agent: [Writing OKF documents with an agent](./guides/okf-authoring.md), and the [validation codes](./reference/okf-validation.md).
- Registering the GitHub App: [GitHub App setup](./github-app-setup.md).
- How it works: [Architecture](./architecture/index.md), beginning with the [system overview](./architecture/overview.md).
- Discussing a document on its page: [Comments](./guides/comments.md).
- Getting answers from the docs in plain language: [Ask the docs](./guides/ask.md).
- Looking something up: [Reference](./reference/index.md) (HTTP API, frontmatter, operations).
- Why it is built this way: [Decisions](./decisions/index.md).

## Contents

| Folder                          | What it holds                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| [Architecture](./architecture/) | System overview, sync engine, data model and security model.                          |
| [Guides](./guides/)             | Getting started, install script, comments, ask, configuration, webhooks, search, OKF. |
| [Reference](./reference/)       | The HTTP API, the frontmatter keys and the operations runbook.                        |
| [Decisions](./decisions/)       | Short records of the choices that shape the design.                                   |

Recent changes are listed in the [change log](./log.md).

## Concept types used in this bundle

OKF types are free-form strings. This bundle keeps to five, so the type filter stays short.

| `type`      | Used for                                             |
| ----------- | ---------------------------------------------------- |
| `Concept`   | An explanation of how a part of the system works.    |
| `Guide`     | Steps to get something done.                         |
| `Reference` | Exact facts to look up: endpoints, keys, limits.     |
| `Runbook`   | What to check and do when operating an instance.     |
| `Decision`  | A design decision with its context and consequences. |

`index.md` and `log.md` are reserved files in OKF. They are not concepts and carry no `type`.

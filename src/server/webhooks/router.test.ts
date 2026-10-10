import { describe, expect, it, vi } from "vitest";

import { repoNameSelection } from "../sync/discovery";
import type { WebhookPayload } from "./endpoint";
import {
  INSTALLATION_UNAVAILABLE_MESSAGES,
  MAX_INDIVIDUAL_ADDED,
  createBackgroundTasks,
  createWebhookRouter,
  type WebhookRouterDeps,
} from "./router";
import { recordingLogger, renderRecord } from "../test-logger";

const INSTALLATION = 4242;
const DELIVERY = "72d3162e-cc78-11e3-81ab-4c9367dc0958";
const HANDBOOK = 101;
const SANDBOX = 303;
// Strings that must never reach the log: payload content a sender controls.
const SECRET_IN_PAYLOAD = "SENTINEL-payload-ghs_token0123";

type D = WebhookRouterDeps;

function setup(
  options: { config?: { repos?: string[]; exclude?: string[] } } & Partial<WebhookRouterDeps> = {},
) {
  const { config = { exclude: ["sandbox"] }, ...overrides } = options;
  const tasks = createBackgroundTasks();
  const defaults = {
    installationId: INSTALLATION,
    narrow: vi.fn<D["narrow"]>((name) => repoNameSelection(config, name)),
    syncRepo: vi.fn<D["syncRepo"]>(async () => "ok"),
    syncAll: vi.fn<D["syncAll"]>(async () => "done"),
    removeRepo: vi.fn<D["removeRepo"]>(async () => "removed"),
    markRepoPrivate: vi.fn<D["markRepoPrivate"]>(async () => true),
    markInstallationUnavailable: vi.fn<D["markInstallationUnavailable"]>(async () => 3),
    detach: vi.fn((task: Promise<void>) => tasks.detach(task)),
    log: recordingLogger(),
  };
  // Overrides in these tests are `vi.fn` mocks too, except the scheduler ones (never inspected).
  const deps = { ...defaults, ...overrides } as typeof defaults;
  const dispatch = createWebhookRouter({ ...deps, log: deps.log.log });
  const send = async (
    event: string,
    payload: WebhookPayload,
    delivery: string | null = DELIVERY,
  ) => {
    await dispatch(event, payload, delivery);
    await tasks.idle();
  };
  // Each record as `event key=value ...` (without time, level and service), for readable asserts.
  const lines = () => deps.log.records.map(renderRecord);
  return { deps, dispatch, send, tasks, lines };
}

function repository(id = HANDBOOK, name = "handbook", extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    full_name: `acme/${name}`,
    default_branch: "main",
    archived: false,
    private: false,
    description: SECRET_IN_PAYLOAD,
    ...extra,
  };
}

function push(extra: Record<string, unknown> = {}, repo = repository()) {
  return {
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    deleted: false,
    created: false,
    repository: repo,
    installation: { id: INSTALLATION },
    head_commit: { message: SECRET_IN_PAYLOAD },
    ...extra,
  };
}

function repoEvent(action: string, repo = repository(), extra: Record<string, unknown> = {}) {
  return { action, repository: repo, installation: { id: INSTALLATION }, ...extra };
}

function installationRepos(action: string, extra: Record<string, unknown>) {
  return {
    action,
    installation: { id: INSTALLATION },
    repository_selection: "selected",
    repositories_added: [],
    repositories_removed: [],
    ...extra,
  };
}

const ref = (id: number, name: string) => ({ id, name, full_name: `acme/${name}`, private: true });

function expectNoWork(deps: ReturnType<typeof setup>["deps"]) {
  expect(deps.syncRepo).not.toHaveBeenCalled();
  expect(deps.syncAll).not.toHaveBeenCalled();
  expect(deps.removeRepo).not.toHaveBeenCalled();
  expect(deps.markRepoPrivate).not.toHaveBeenCalled();
  expect(deps.markInstallationUnavailable).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------------------------

describe("push", () => {
  it("syncs the repository once for a push to its default branch", async () => {
    const { deps, send, lines } = setup();
    await send("push", push());
    expect(deps.syncRepo).toHaveBeenCalledTimes(1);
    expect(deps.syncRepo).toHaveBeenCalledWith(HANDBOOK);
    expect(deps.detach).toHaveBeenCalledTimes(1);
    expect(lines()).toContain(
      `webhook.decision githubEvent=push action=- deliveryId=${DELIVERY} decision=sync_scheduled githubId=${HANDBOOK}`,
    );
    expect(lines()).toContain(
      `webhook.task.finished githubEvent=push action=- deliveryId=${DELIVERY} task=sync githubId=${HANDBOOK} status=ok`,
    );
  });

  it("follows the repository's own default branch", async () => {
    const { deps, send } = setup();
    await send(
      "push",
      push(
        { ref: "refs/heads/trunk" },
        repository(HANDBOOK, "handbook", { default_branch: "trunk" }),
      ),
    );
    expect(deps.syncRepo).toHaveBeenCalledWith(HANDBOOK);
  });

  it.each([
    ["a feature branch", { ref: "refs/heads/feature/x" }],
    ["a tag named like the branch", { ref: "refs/tags/main" }],
    ["a bare branch name", { ref: "main" }],
    ["a deleted default branch", { deleted: true }],
  ])("does nothing for %s", async (_label, extra) => {
    const { deps, send, lines } = setup();
    await send("push", push(extra));
    expectNoWork(deps);
    expect(deps.detach).not.toHaveBeenCalled();
    expect(lines().join("\n")).toMatch(/decision=ignored/);
  });

  it("does nothing for an archived repository", async () => {
    const { deps, send } = setup();
    await send("push", push({}, repository(HANDBOOK, "handbook", { archived: true })));
    expectNoWork(deps);
  });

  it("does nothing for an excluded repository (case-insensitive)", async () => {
    const { deps, send, lines } = setup();
    await send("push", push({}, repository(SANDBOX, "SandBox")));
    expectNoWork(deps);
    expect(lines()).toContain(
      `webhook.decision githubEvent=push action=- deliveryId=${DELIVERY} decision=ignored reason=not_selected githubId=${SANDBOX}`,
    );
  });

  it("does nothing for a repository outside an explicit list", async () => {
    const { deps, send } = setup({ config: { repos: ["metrics"] } });
    await send("push", push());
    expectNoWork(deps);
  });

  it("does nothing for another installation of the App", async () => {
    const { deps, send, lines } = setup();
    await send("push", push({ installation: { id: 999 } }));
    expectNoWork(deps);
    expect(lines().join("\n")).toMatch(/decision=ignored reason=other_installation/);
  });
});

describe("repository", () => {
  it("removes a deleted repository as deleted", async () => {
    const { deps, send } = setup();
    await send("repository", repoEvent("deleted"));
    expect(deps.removeRepo).toHaveBeenCalledExactlyOnceWith(HANDBOOK, "deleted");
    expect(deps.syncRepo).not.toHaveBeenCalled();
  });

  it("removes a deleted repository even when it is outside the narrowing", async () => {
    const { deps, send } = setup();
    await send("repository", repoEvent("deleted", repository(SANDBOX, "sandbox")));
    expect(deps.removeRepo).toHaveBeenCalledExactlyOnceWith(SANDBOX, "deleted");
  });

  it("removes an archived repository as archived", async () => {
    const { deps, send } = setup();
    await send(
      "repository",
      repoEvent("archived", repository(HANDBOOK, "handbook", { archived: true })),
    );
    expect(deps.removeRepo).toHaveBeenCalledExactlyOnceWith(HANDBOOK, "archived");
    expect(deps.syncRepo).not.toHaveBeenCalled();
  });

  it("syncs an unarchived repository within the selection", async () => {
    const { deps, send } = setup();
    await send("repository", repoEvent("unarchived"));
    expect(deps.syncRepo).toHaveBeenCalledExactlyOnceWith(HANDBOOK);
  });

  it("ignores an unarchived repository outside the selection", async () => {
    const { deps, send } = setup();
    await send("repository", repoEvent("unarchived", repository(SANDBOX, "sandbox")));
    expectNoWork(deps);
  });

  it("syncs a renamed repository by id so its owner and name update", async () => {
    const { deps, send } = setup();
    await send(
      "repository",
      repoEvent("renamed", repository(HANDBOOK, "handbook-v2"), {
        changes: { repository: { name: { from: "handbook" } } },
      }),
    );
    expect(deps.syncRepo).toHaveBeenCalledExactlyOnceWith(HANDBOOK);
    expect(deps.removeRepo).not.toHaveBeenCalled();
  });

  it("removes a repository renamed out of an explicit list as dropped_from_config", async () => {
    const { deps, send } = setup({ config: { repos: ["handbook"] } });
    await send("repository", repoEvent("renamed", repository(HANDBOOK, "handbook-v2")));
    expect(deps.removeRepo).toHaveBeenCalledExactlyOnceWith(HANDBOOK, "dropped_from_config");
    expect(deps.syncRepo).not.toHaveBeenCalled();
  });

  it("removes a repository renamed into the exclusions as excluded", async () => {
    const { deps, send } = setup();
    await send("repository", repoEvent("renamed", repository(HANDBOOK, "sandbox")));
    expect(deps.removeRepo).toHaveBeenCalledExactlyOnceWith(HANDBOOK, "excluded");
  });

  it("makes a privatized repository private before resolving, then syncs it", async () => {
    let releaseSync!: () => void;
    const order: string[] = [];
    const { deps, dispatch, tasks } = setup({
      markRepoPrivate: vi.fn(async () => (order.push("private"), true)),
      syncRepo: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            order.push("sync started");
            releaseSync = () => resolve("ok");
          }),
      ),
    });
    await dispatch(
      "repository",
      repoEvent("privatized", repository(HANDBOOK, "handbook", { private: true })),
      DELIVERY,
    );
    // Resolved with the visibility already applied; the sync is still running in the background.
    expect(deps.markRepoPrivate).toHaveBeenCalledExactlyOnceWith(HANDBOOK);
    await vi.waitFor(() => expect(order).toEqual(["private", "sync started"]));
    expect(tasks.size).toBe(1);
    releaseSync();
    await tasks.idle();
    expect(deps.syncRepo).toHaveBeenCalledExactlyOnceWith(HANDBOOK);
  });

  it("still makes a privatized repository private when it is outside the selection, without syncing", async () => {
    const { deps, send } = setup();
    await send("repository", repoEvent("privatized", repository(SANDBOX, "sandbox")));
    expect(deps.markRepoPrivate).toHaveBeenCalledExactlyOnceWith(SANDBOX);
    expect(deps.syncRepo).not.toHaveBeenCalled();
  });

  it("rejects with a fixed error when the immediate visibility update fails, and starts no sync", async () => {
    const { deps, dispatch, lines } = setup({
      markRepoPrivate: vi.fn(async () => {
        throw new Error(`connection to postgres://u:${SECRET_IN_PAYLOAD}@db failed`);
      }),
    });
    const error = await dispatch("repository", repoEvent("privatized"), DELIVERY).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(SECRET_IN_PAYLOAD);
    expect(deps.syncRepo).not.toHaveBeenCalled();
    expect(lines().join("\n")).not.toContain(SECRET_IN_PAYLOAD);
    expect(lines().join("\n")).toContain("webhook.update_failed");
    expect(lines().join("\n")).toContain("update=visibility_update");
  });

  it("syncs a publicized repository and leaves the visibility to that sync", async () => {
    const { deps, send } = setup();
    await send("repository", repoEvent("publicized"));
    expect(deps.syncRepo).toHaveBeenCalledExactlyOnceWith(HANDBOOK);
    expect(deps.markRepoPrivate).not.toHaveBeenCalled();
  });

  it.each(["edited", "created", "transferred"])(
    "syncs a selected repository on %s",
    async (action) => {
      const { deps, send } = setup();
      await send("repository", repoEvent(action));
      expect(deps.syncRepo).toHaveBeenCalledExactlyOnceWith(HANDBOOK);
    },
  );

  it("ignores an edited repository outside the selection", async () => {
    const { deps, send } = setup();
    await send("repository", repoEvent("edited", repository(SANDBOX, "sandbox")));
    expectNoWork(deps);
  });

  it("ignores an edited archived repository", async () => {
    const { deps, send } = setup();
    await send(
      "repository",
      repoEvent("edited", repository(HANDBOOK, "handbook", { archived: true })),
    );
    expectNoWork(deps);
  });

  it("ignores unknown actions", async () => {
    const { deps, send, lines } = setup();
    await send("repository", repoEvent("frobnicated"));
    expectNoWork(deps);
    expect(lines().join("\n")).toMatch(
      /githubEvent=repository action=frobnicated deliveryId=\S+ decision=ignored reason=unhandled_action/,
    );
  });

  it("ignores another installation", async () => {
    const { deps, send } = setup();
    await send("repository", { ...repoEvent("deleted"), installation: { id: 7 } });
    expectNoWork(deps);
  });
});

describe("installation_repositories", () => {
  it("syncs each added repository within the selection, one at a time", async () => {
    const running: number[] = [];
    let concurrent = 0;
    const { deps, send } = setup({
      syncRepo: vi.fn(async (id: number) => {
        running.push(id);
        concurrent = Math.max(concurrent, running.length);
        await new Promise((r) => setTimeout(r, 5));
        running.splice(running.indexOf(id), 1);
        return "ok";
      }),
    });
    await send(
      "installation_repositories",
      installationRepos("added", {
        repositories_added: [
          ref(HANDBOOK, "handbook"),
          ref(SANDBOX, "sandbox"),
          ref(202, "metrics"),
        ],
      }),
    );
    expect(deps.syncRepo.mock.calls.map((c) => c[0])).toEqual([HANDBOOK, 202]);
    expect(concurrent).toBe(1);
    expect(deps.syncAll).not.toHaveBeenCalled();
    expect(deps.detach).toHaveBeenCalledTimes(1);
  });

  it("ignores added repositories outside the selection", async () => {
    const { deps, send } = setup();
    await send(
      "installation_repositories",
      installationRepos("added", { repositories_added: [ref(SANDBOX, "sandbox")] }),
    );
    expectNoWork(deps);
  });

  it("runs a full sync when the installation covers all repositories", async () => {
    const { deps, send } = setup();
    await send(
      "installation_repositories",
      installationRepos("added", {
        repository_selection: "all",
        repositories_added: [ref(HANDBOOK, "handbook")],
      }),
    );
    expect(deps.syncAll).toHaveBeenCalledTimes(1);
    expect(deps.syncRepo).not.toHaveBeenCalled();
  });

  it("runs a full sync when the added list is long", async () => {
    const { deps, send } = setup();
    const many = Array.from({ length: MAX_INDIVIDUAL_ADDED + 1 }, (_, i) => ref(1000 + i, `r${i}`));
    await send(
      "installation_repositories",
      installationRepos("added", { repositories_added: many }),
    );
    expect(deps.syncAll).toHaveBeenCalledTimes(1);
    expect(deps.syncRepo).not.toHaveBeenCalled();
  });

  it("removes each removed repository as not_in_installation, whatever the narrowing", async () => {
    const { deps, send } = setup();
    await send(
      "installation_repositories",
      installationRepos("removed", {
        repositories_removed: [
          ref(HANDBOOK, "handbook"),
          ref(SANDBOX, "sandbox"),
          ref(HANDBOOK, "handbook"),
        ],
      }),
    );
    expect(deps.removeRepo.mock.calls).toEqual([
      [HANDBOOK, "not_in_installation"],
      [SANDBOX, "not_in_installation"],
    ]);
    expect(deps.syncRepo).not.toHaveBeenCalled();
  });

  it("keeps removing after one removal fails", async () => {
    const { deps, send, lines } = setup({
      removeRepo: vi.fn(async (id: number) => {
        if (id === HANDBOOK) throw new Error(SECRET_IN_PAYLOAD);
        return "removed";
      }),
    });
    await send(
      "installation_repositories",
      installationRepos("removed", {
        repositories_removed: [ref(HANDBOOK, "a"), ref(SANDBOX, "b")],
      }),
    );
    expect(deps.removeRepo).toHaveBeenCalledTimes(2);
    expect(lines().join("\n")).toContain(
      `webhook.task.failed githubEvent=installation_repositories action=removed deliveryId=${DELIVERY} task=removal githubId=${HANDBOOK} errorName=Error`,
    );
    expect(lines().join("\n")).not.toContain(SECRET_IN_PAYLOAD);
  });

  it("ignores another installation", async () => {
    const { deps, send } = setup();
    await send("installation_repositories", {
      ...installationRepos("removed", { repositories_removed: [ref(HANDBOOK, "a")] }),
      installation: { id: 1 },
    });
    expectNoWork(deps);
  });
});

describe("installation", () => {
  it.each(["deleted", "suspend"] as const)(
    "marks every repo unavailable on %s before resolving, and deletes nothing",
    async (action) => {
      const { deps, dispatch, lines } = setup();
      await dispatch("installation", { action, installation: { id: INSTALLATION } }, DELIVERY);
      expect(deps.markInstallationUnavailable).toHaveBeenCalledExactlyOnceWith(action);
      expect(deps.removeRepo).not.toHaveBeenCalled();
      expect(deps.syncAll).not.toHaveBeenCalled();
      expect(deps.detach).not.toHaveBeenCalled();
      expect(lines()).toContain(
        `webhook.decision githubEvent=installation action=${action} deliveryId=${DELIVERY} decision=installation_unavailable reason=${action} count=3`,
      );
    },
  );

  it("records the reason in the message", () => {
    expect(INSTALLATION_UNAVAILABLE_MESSAGES.suspend).toMatch(
      /^GitHub App installation unavailable/,
    );
    expect(INSTALLATION_UNAVAILABLE_MESSAGES.suspend).toMatch(/suspended/);
    expect(INSTALLATION_UNAVAILABLE_MESSAGES.deleted).toMatch(
      /^GitHub App installation unavailable/,
    );
    expect(INSTALLATION_UNAVAILABLE_MESSAGES.deleted).toMatch(/uninstalled/);
  });

  it.each(["unsuspend", "created", "new_permissions_accepted"])(
    "runs a full sync to recover on %s",
    async (action) => {
      const { deps, send } = setup();
      await send("installation", { action, installation: { id: INSTALLATION } });
      expect(deps.syncAll).toHaveBeenCalledTimes(1);
      expect(deps.markInstallationUnavailable).not.toHaveBeenCalled();
    },
  );

  it("ignores events for another installation id", async () => {
    const { deps, send } = setup();
    await send("installation", { action: "suspend", installation: { id: INSTALLATION + 1 } });
    await send("installation", { action: "unsuspend", installation: { id: INSTALLATION + 1 } });
    expectNoWork(deps);
  });

  it("ignores unknown actions", async () => {
    const { deps, send } = setup();
    await send("installation", { action: "renamed", installation: { id: INSTALLATION } });
    expectNoWork(deps);
  });

  it("rejects with a fixed error when marking fails", async () => {
    const { dispatch } = setup({
      markInstallationUnavailable: vi.fn(async () => {
        throw new Error(SECRET_IN_PAYLOAD);
      }),
    });
    await expect(
      dispatch("installation", { action: "suspend", installation: { id: INSTALLATION } }, DELIVERY),
    ).rejects.toThrow(/^webhook: installation error marking failed$/);
  });
});

describe("malformed payloads and other events", () => {
  it.each([
    [
      "push without repository",
      "push",
      { ref: "refs/heads/main", installation: { id: INSTALLATION } },
    ],
    ["push with a string id", "push", push({}, repository("101" as unknown as number))],
    ["push without installation", "push", { ...push(), installation: undefined }],
    ["push with a negative id", "push", push({}, repository(-1))],
    [
      "repository without action",
      "repository",
      { repository: repository(), installation: { id: INSTALLATION } },
    ],
    ["repository with an empty name", "repository", repoEvent("deleted", repository(HANDBOOK, ""))],
    [
      "installation_repositories with a non-list",
      "installation_repositories",
      installationRepos("removed", { repositories_removed: "all" }),
    ],
    [
      "installation with a string id",
      "installation",
      { action: "suspend", installation: { id: "4242" } },
    ],
  ])("ignores %s", async (_label, event, payload) => {
    const { deps, dispatch, lines } = setup();
    await expect(dispatch(event, payload as WebhookPayload, DELIVERY)).resolves.toBeUndefined();
    expectNoWork(deps);
    expect(lines().join("\n")).toMatch(/decision=ignored reason=malformed_payload/);
  });

  it.each(["check_run", "issues", "pull_request", "installation_target", "star"])(
    "acknowledges and ignores %s",
    async (event) => {
      const { deps, send, lines } = setup();
      await send(event, repoEvent("created"));
      expectNoWork(deps);
      expect(lines()).toEqual([
        `webhook.decision githubEvent=${event} action=created deliveryId=${DELIVERY} decision=ignored reason=unhandled_event`,
      ]);
    },
  );

  it("logs no payload content, and sanitises the action and delivery id", async () => {
    const { send, lines } = setup();
    const name = `handbook\nFAKE LOG LINE ${SECRET_IN_PAYLOAD}`;
    await send("push", push({}, repository(HANDBOOK, name)), `bad id\n${SECRET_IN_PAYLOAD}`);
    await send("repository", repoEvent(`x\n${SECRET_IN_PAYLOAD}`), null);
    await send("repository", repoEvent("renamed", repository(HANDBOOK, name)));
    const text = lines().join("\n");
    expect(text).not.toContain(SECRET_IN_PAYLOAD);
    expect(text).not.toContain("FAKE LOG LINE");
    expect(text).toContain("deliveryId=invalid");
    expect(text).toContain("deliveryId=none");
    expect(text).toContain("action=-");
  });
});

describe("background work", () => {
  it("resolves without waiting for a sync that never finishes", async () => {
    const never = vi.fn(() => new Promise<string>(() => undefined));
    const { deps, dispatch, tasks } = setup({ syncRepo: never });
    await expect(dispatch("push", push(), DELIVERY)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(never).toHaveBeenCalledTimes(1));
    expect(tasks.size).toBe(1);
    expect(deps.detach).toHaveBeenCalledTimes(1);
  });

  it("resolves without waiting for a full sync or removal that never finishes", async () => {
    const never = () => new Promise<string>(() => undefined);
    const { dispatch, tasks } = setup({ syncAll: vi.fn(never), removeRepo: vi.fn(never) });
    await dispatch(
      "installation",
      { action: "unsuspend", installation: { id: INSTALLATION } },
      DELIVERY,
    );
    await dispatch("repository", repoEvent("deleted"), DELIVERY);
    expect(tasks.size).toBe(2);
  });

  it("catches a failing sync and logs fixed text only", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { send, lines } = setup({
        syncRepo: vi.fn(async () => {
          throw new Error(`token ${SECRET_IN_PAYLOAD}`);
        }),
      });
      await send("push", push());
      expect(lines()).toContain(
        `webhook.task.failed githubEvent=push action=- deliveryId=${DELIVERY} task=sync githubId=${HANDBOOK} errorName=Error`,
      );
      expect(lines().join("\n")).not.toContain(SECRET_IN_PAYLOAD);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("catches a sync that throws synchronously", async () => {
    const { dispatch, tasks, lines } = setup({
      syncRepo: vi.fn((): Promise<string> => {
        throw new Error(SECRET_IN_PAYLOAD);
      }),
    });
    await expect(dispatch("push", push(), DELIVERY)).resolves.toBeUndefined();
    await tasks.idle();
    expect(lines().join("\n")).toContain("webhook.task.failed");
  });

  it("survives a scheduler that throws", async () => {
    const syncRepo = vi.fn(async () => "ok");
    const { dispatch } = setup({
      syncRepo,
      detach: () => {
        throw new Error("scheduler broken");
      },
    });
    await expect(dispatch("push", push(), DELIVERY)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(syncRepo).toHaveBeenCalledTimes(1));
  });

  it("works with no scheduler", async () => {
    const syncRepo = vi.fn(async () => "ok");
    const { dispatch } = setup({ syncRepo, detach: undefined });
    await dispatch("push", push(), DELIVERY);
    await vi.waitFor(() => expect(syncRepo).toHaveBeenCalledTimes(1));
  });

  it("logs only status words from the engine", async () => {
    const { send, lines } = setup({ syncRepo: vi.fn(async () => `weird ${SECRET_IN_PAYLOAD}`) });
    await send("push", push());
    expect(lines()).toContain(
      `webhook.task.finished githubEvent=push action=- deliveryId=${DELIVERY} task=sync githubId=${HANDBOOK} status=unknown`,
    );
  });
});

describe("createBackgroundTasks", () => {
  it("tracks tasks until they settle and waits for tasks added while waiting", async () => {
    const tasks = createBackgroundTasks();
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    tasks.detach(first);
    let secondDone = false;
    void first.then(() =>
      tasks.detach(new Promise<void>((r) => setTimeout(() => ((secondDone = true), r()), 5))),
    );
    expect(tasks.size).toBe(1);
    const idle = tasks.idle();
    release();
    await idle;
    expect(secondDone).toBe(true);
    expect(tasks.size).toBe(0);
  });

  it("swallows a rejected task", async () => {
    const tasks = createBackgroundTasks();
    tasks.detach(Promise.reject(new Error("x")));
    await expect(tasks.idle()).resolves.toBeUndefined();
  });
});

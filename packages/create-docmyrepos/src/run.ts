import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { helpText, parseCommandLine, UsageError, type Options } from "./args.js";
import type { OpenBrowser } from "./browser.js";
import {
  ManifestCallbackError,
  parsePastedCode,
  startManifestCallback,
  type ManifestCallbackHandle,
} from "./callback.js";
import { BOOTSTRAP_LINES, removeBootstrapCredentials, RESTART_COMMAND } from "./cleanup.js";
import {
  checkPortFree,
  composePull,
  composeUp,
  MORE_LOGS_COMMAND,
  preflight,
  type CheckResult,
  type Runner,
} from "./docker.js";
import {
  InstallationExistsError,
  INSTALL_MARKERS,
  WriteInterruptedError,
  writeInstallation,
  type FsOps,
} from "./files.js";
import {
  createGithubClient,
  detectPermissionWarnings,
  findInstallation,
  GithubError,
  resolveGithubApiUrl,
  type GithubClient,
  type InstallationLookup,
} from "./github.js";
import { createAppJwt } from "./jwt.js";
import { buildManifest, isPublicHttpsAddress } from "./manifest.js";
import {
  createOutput,
  createRedactor,
  EXIT,
  redactingIo,
  summarizeFiles,
  type ExitCode,
  type Output,
} from "./output.js";
import { normalizePem, pemProblem } from "./pem.js";
import {
  chooseKeyLayout,
  currentHost,
  plan,
  PlanError,
  type HostInfo,
  type InstallPlan,
} from "./plan.js";
import {
  createPrompter,
  InputClosedError,
  MissingAnswersError,
  type PromptIo,
  type Prompter,
} from "./prompts.js";
import { generateSecret } from "./secrets.js";
import {
  parseRepositoryList,
  validateAddress,
  validateEmail,
  validateImageTag,
  validateNumericId,
  validateOrganization,
  validatePort,
  validateSharedSecret,
  type Check,
} from "./validate.js";

export const MIN_NODE_MAJOR = 20;
export const SETUP_GUIDE_URL =
  "https://github.com/Dash-AI-Tools/doc-my-repos/blob/main/docs/github-app-setup.md";

/** Everything the wizard touches outside itself. Production wiring is in `cli.ts`; tests inject fakes. */
export interface RunDeps {
  /** Command-line arguments without the node and script paths. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly io: PromptIo;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly runner: Runner;
  /** Used for GitHub and for the call to the local app's sync endpoint. */
  readonly fetch: typeof fetch;
  readonly openBrowser: OpenBrowser;
  /** Aborted by SIGINT or SIGTERM. */
  readonly signal: AbortSignal;
  /** The installer's own version (also the default image tag). */
  readonly version: string;
  /** `process.versions.node`. */
  readonly nodeVersion: string;
  readonly host?: HostInfo;
  readonly portCheck?: (port: number) => Promise<CheckResult>;
  readonly fs?: FsOps;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timing?: {
    readonly callbackTimeoutMs?: number;
    readonly installationTimeoutMs?: number;
    readonly installationIntervalMs?: number;
    readonly healthTimeoutSeconds?: number;
  };
}

/** The run ends here; the reason was already printed. */
class Stop extends Error {
  readonly code: ExitCode;
  constructor(code: ExitCode) {
    super("stopped");
    this.name = "Stop";
    this.code = code;
  }
}

class InterruptedError extends Error {
  constructor() {
    super("Interrupted.");
    this.name = "InterruptedError";
  }
}

/** A problem with a value the user supplied for an existing App. The message is fixed text. */
class AppInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppInputError";
  }
}

export function nodeMajor(version: string): number {
  return Number(version.split(".")[0] ?? "0");
}

interface AppCredentials {
  readonly appId: number;
  readonly slug: string;
  readonly name: string;
  readonly pem: string;
  readonly webhookSecret: string;
}

interface ExistingInput {
  readonly appId: number;
  readonly keyFile: string;
  readonly webhookSecret: string;
  readonly installationId: number | undefined;
}

type Repos = "all" | readonly string[];

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("internal error: an answer was not collected");
  return value;
};

const nonEmpty = (input: string): Check<string> =>
  input.trim() === ""
    ? { ok: false, reason: "This answer must not be empty." }
    : { ok: true, value: input.trim() };

const reposCheck = (input: string): Check<Repos> => {
  const text = input.trim();
  if (text.toLowerCase() === "all") return { ok: true, value: "all" };
  return parseRepositoryList(text);
};

const choiceCheck =
  (choices: readonly string[]) =>
  (input: string): Check<string> => {
    const value = input.trim().toLowerCase();
    return choices.includes(value)
      ? { ok: true, value }
      : { ok: false, reason: `Choose one of: ${choices.join(", ")}.` };
  };

/** Runs the installer. Returns the process exit code and never throws. */
export async function run(deps: RunDeps): Promise<ExitCode> {
  const redactor = createRedactor();
  const out = createOutput({ stdout: deps.stdout, stderr: deps.stderr }, redactor);
  const state = { wrote: false, dir: "" };
  try {
    return await wizard(deps, out, state);
  } catch (error) {
    return reportFailure(error, deps, out, state);
  }
}

function reportFailure(
  error: unknown,
  deps: RunDeps,
  out: Output,
  state: { wrote: boolean; dir: string },
): ExitCode {
  if (error instanceof Stop) return error.code;
  if (
    deps.signal.aborted ||
    error instanceof InterruptedError ||
    error instanceof WriteInterruptedError ||
    (error instanceof ManifestCallbackError && error.reason === "aborted")
  ) {
    out.blank();
    out.error(
      state.wrote
        ? `Interrupted. The files in ${state.dir} were written completely and were kept.`
        : "Interrupted. Nothing was written.",
    );
    return EXIT.INTERRUPT;
  }
  if (error instanceof UsageError) {
    out.error(error.message);
    return EXIT.USAGE;
  }
  if (error instanceof MissingAnswersError) {
    out.error(error.message);
    out.info("Run with --help to see every option and environment variable.");
    return EXIT.USAGE;
  }
  if (error instanceof InputClosedError) {
    out.error(`${error.message} Nothing more was done.`);
    return EXIT.FAILURE;
  }
  if (error instanceof InstallationExistsError || error instanceof GithubError) {
    out.error(error.message);
    return EXIT.FAILURE;
  }
  if (error instanceof PlanError || error instanceof AppInputError) {
    out.error(error.message);
    return EXIT.FAILURE;
  }
  out.error(`Unexpected failure: ${error instanceof Error ? error.message : "unknown error"}`);
  return EXIT.FAILURE;
}

async function checkTarget(dir: string, force: boolean): Promise<void> {
  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!info.isDirectory()) throw new AppInputError(`${dir} exists and is not a folder.`);
  if (force) return;
  const existing: string[] = [];
  for (const marker of INSTALL_MARKERS) {
    try {
      await lstat(join(dir, marker));
      existing.push(marker);
    } catch {
      // not there
    }
  }
  if (existing.length > 0) throw new InstallationExistsError(existing);
}

async function wizard(
  deps: RunDeps,
  out: Output,
  state: { wrote: boolean; dir: string },
): Promise<ExitCode> {
  const options = parseCommandLine(deps.argv);
  if (options.help) {
    deps.stdout(helpText(deps.version));
    return EXIT.OK;
  }
  if (options.version) {
    deps.stdout(`${deps.version}\n`);
    return EXIT.OK;
  }
  if (nodeMajor(deps.nodeVersion) < MIN_NODE_MAJOR) {
    out.error(
      `create-docmyrepos needs Node.js ${MIN_NODE_MAJOR} or newer; this is ${deps.nodeVersion}. Nothing was changed.`,
    );
    return EXIT.FAILURE;
  }
  if (!deps.io.interactive && !options.yes) {
    throw new UsageError(
      "Input is not a terminal. Pass --yes and supply every answer with options and environment variables (see --help).",
    );
  }
  const apiUrl = resolveGithubApiUrl(deps.env);
  if (!apiUrl.ok) throw new UsageError(apiUrl.reason);
  const tag = validateImageTag(options.imageTag ?? deps.version);
  if (!tag.ok) throw new UsageError(`--image-tag: ${tag.reason}`);

  const { redactor } = out;
  const io = redactingIo(deps.io, redactor);
  const prompter = createPrompter(io, { assumeYes: options.yes });
  const host = deps.host ?? currentHost();
  const dir = resolve(deps.cwd, options.dir ?? "docmyrepos");
  state.dir = dir;
  const portCheck = deps.portCheck ?? checkPortFree;
  const checkAbort = (): void => {
    if (deps.signal.aborted) throw new InterruptedError();
  };
  const client = createGithubClient({
    fetch: deps.fetch,
    baseUrl: apiUrl.value,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });

  out.info(`create-docmyrepos ${deps.version}`);
  if (options.dryRun) out.info("Dry run: nothing will be written, created or started.");

  // 1. Prerequisites, cheapest first, before any question that costs effort.
  out.step("Checking this machine");
  await checkTarget(dir, options.force);
  const pre = await preflight(deps.runner, 0, () =>
    Promise.resolve({ ok: true, value: undefined }),
  );
  const problems = pre.problems.filter((p) => !(options.noStart && p.check === "daemon"));
  if (problems.length > 0) {
    for (const problem of problems) {
      out.error(problem.message);
      out.detail(`How to fix: ${problem.fix}`);
    }
    out.info("Nothing was written.");
    return EXIT.FAILURE;
  }
  out.detail(
    `Docker ${pre.compose === undefined ? "" : `with Compose ${pre.compose.version} `}found.`,
  );
  checkAbort();

  // 2. Answers. In non-interactive mode a missing answer is recorded and all are listed together.
  out.step("Collecting answers");
  const org = await prompter.ask({
    key: "--org",
    label: "GitHub organization",
    ...(options.org === undefined ? {} : { preset: options.org }),
    validate: validateOrganization,
  });
  const address = await prompter.ask({
    key: "--url",
    label: "Address the portal will be reached at",
    default: "http://localhost:3000",
    ...(options.url === undefined ? {} : { preset: options.url }),
    validate: validateAddress,
  });
  let defaultPort = "3000";
  if (address?.loopback === true) {
    const explicit = new URL(address.url).port;
    if (explicit !== "") defaultPort = explicit;
  }
  const askPort = (preset: string | undefined, fallback: string): Promise<number | undefined> =>
    prompter.ask({
      key: "--port",
      label: "Host port",
      default: fallback,
      ...(preset === undefined ? {} : { preset }),
      validate: validatePort,
    });
  let port = await askPort(options.port, defaultPort);
  const ensurePortFree = async (first: number): Promise<number> => {
    let current = first;
    for (;;) {
      const free = await portCheck(current);
      if (free.ok) return current;
      out.error(free.problem.message);
      out.detail(`How to fix: ${free.problem.fix}`);
      if (!prompter.prompting) {
        out.info("Nothing was written.");
        throw new Stop(EXIT.FAILURE);
      }
      current = must(await askPort(undefined, String(Math.min(current + 1, 65535))));
    }
  };
  if (prompter.prompting && port !== undefined) port = await ensurePortFree(port);
  const adminEmail = await prompter.ask({
    key: "--admin-email",
    label: "First admin's email",
    ...(options.adminEmail === undefined ? {} : { preset: options.adminEmail }),
    validate: validateEmail,
  });
  const adminPassword = await prompter.askPassword({
    key: "DOCMYREPOS_ADMIN_PASSWORD",
    label: "First admin's password",
    ...(deps.env.DOCMYREPOS_ADMIN_PASSWORD === undefined
      ? {}
      : { preset: deps.env.DOCMYREPOS_ADMIN_PASSWORD }),
    offerGenerate: true,
  });
  if (adminPassword !== undefined) redactor.add(adminPassword.value);
  const reposAnswer =
    options.repos === undefined
      ? undefined
      : await prompter.ask({
          key: "--repos",
          label: "Repositories (all, or a comma-separated list of names)",
          preset: options.repos,
          validate: reposCheck,
        });
  const appRoute = await prompter.ask({
    key: "--app",
    label: "GitHub App: create one in your browser, or use an existing one (create/existing)",
    ...(prompter.prompting ? { default: "create" } : {}),
    ...(options.app === undefined ? {} : { preset: options.app }),
    validate: choiceCheck(["create", "existing"]),
  });
  let existingInput: ExistingInput | undefined;
  if (appRoute === "existing") existingInput = await askExisting(prompter, io, deps.env, true);
  prompter.assertComplete();
  if (appRoute === "create" && !prompter.prompting) {
    throw new UsageError(
      "Creating the GitHub App needs a browser and cannot run without prompts. Use --app existing with DOCMYREPOS_APP_ID, DOCMYREPOS_APP_KEY_FILE and DOCMYREPOS_WEBHOOK_SECRET.",
    );
  }

  const orgName = must(org);
  const portal = must(address);
  if (portal.warning !== undefined) out.warn(portal.warning);
  const email = must(adminEmail);
  const password = must(adminPassword);
  let hostPort = must(port);
  if (!prompter.prompting) hostPort = await ensurePortFree(hostPort);
  checkAbort();

  if (options.dryRun) {
    return dryRun({
      deps,
      out,
      options,
      prompter,
      client,
      host,
      dir,
      tag: tag.value,
      hostPort,
      appRoute: must(appRoute),
      orgName,
      portal: portal.url,
      existingInput,
      reposAnswer,
    });
  }

  // 3. The GitHub App.
  out.step(appRoute === "create" ? "Creating the GitHub App" : "Checking the GitHub App");
  const appContext = { deps, out, options, prompter, io, client, orgName, portalUrl: portal.url };
  let app: AppCredentials;
  let installationId: number | undefined;
  let created = false;
  if (appRoute === "create") {
    const result = await createApp(appContext);
    app = result.app;
    created = result.created;
    installationId = result.installationId;
  } else {
    const result = await resolveExistingApp(appContext, must(existingInput));
    app = result.app;
    installationId = result.installationId;
  }
  redactor.add(app.pem);
  redactor.add(app.webhookSecret);
  checkAbort();

  const jwt = (): string => {
    const token = createAppJwt(app.appId, app.pem);
    redactor.add(token);
    return token;
  };

  // 4. The installation.
  out.step(`Finding the installation on ${orgName}`);
  if (installationId === undefined) {
    installationId = await waitForInstallation(appContext, app, jwt);
  } else {
    out.detail(`Using installation ${installationId}.`);
  }
  checkAbort();

  // 5. Repositories.
  out.step("Choosing repositories");
  let repos: Repos;
  if (reposAnswer !== undefined) {
    repos = reposAnswer;
    out.detail(
      repos === "all" ? "All repositories the App can access." : `${repos.length} chosen.`,
    );
  } else if (!prompter.prompting) {
    repos = "all";
    out.detail("All repositories the App can access (the default).");
  } else {
    repos = await pickRepositories(appContext, jwt, installationId);
  }
  checkAbort();

  // 6. Secrets, the plan and the confirmation.
  const generated = {
    sessionSecret: generateSecret(),
    syncSecret: generateSecret(),
    postgresPassword: generateSecret(),
  };
  for (const secret of Object.values(generated)) redactor.add(secret);
  let webhookSecret = app.webhookSecret;
  if (!validateSharedSecret(webhookSecret).ok) {
    webhookSecret = generateSecret();
    redactor.add(webhookSecret);
    out.warn(
      "The webhook secret GitHub issued is shorter than the app accepts, so a generated one is used. If you turn the webhook on later, set this same secret in the App's settings (it is GITHUB_WEBHOOK_SECRET in .env).",
    );
  }
  out.step("Reviewing what will be written");
  const installPlan: InstallPlan = plan({
    org: orgName,
    url: portal.url,
    port: hostPort,
    adminEmail: email,
    adminPassword: password.value,
    repos,
    appId: app.appId,
    installationId,
    privateKeyPem: app.pem,
    webhookSecret,
    ...generated,
    imageTag: tag.value,
    host,
  });
  for (const line of summarizeFiles(
    dir,
    installPlan.files,
    `The private key is stored ${installPlan.keyLayout === "file" ? "as a file" : "inline in .env"}: ${installPlan.keyLayoutReason}`,
  )) {
    out.info(line);
  }
  printCommands(out, hostPort, options.noStart);
  if (
    !(await prompter.confirm(
      options.noStart ? "Write these files?" : "Write these files and start DocMyRepos?",
      true,
    ))
  ) {
    out.info("Nothing was written.");
    return EXIT.FAILURE;
  }
  checkAbort();

  // 7. Write.
  out.step("Writing files");
  const written = await writeInstallation({
    dir,
    files: installPlan.files,
    force: options.force,
    ...(deps.fs === undefined ? {} : { fs: deps.fs }),
    onInterrupt: () => undefined,
  });
  state.wrote = true;
  for (const backup of written.backups) out.detail(`Backed up ${backup.from} to ${backup.to}`);
  out.detail(`Wrote ${written.written.length} files to ${dir}.`);

  // 8. Start and 9. first sync.
  let syncStarted = false;
  if (!options.noStart) {
    out.step("Pulling the image and starting DocMyRepos (this can take a few minutes)");
    const pull = await composePull(deps.runner, dir);
    if (!pull.ok) return startFailed(out, dir, pull.step, pull.message, pull.logTail);
    checkAbort();
    const up = await composeUp(deps.runner, dir, {
      port: hostPort,
      waitSupported: pre.compose?.waitSupported ?? false,
      ...(deps.timing?.healthTimeoutSeconds === undefined
        ? {}
        : { waitSeconds: deps.timing.healthTimeoutSeconds }),
    });
    if (!up.ok) return startFailed(out, dir, up.step, up.message, up.logTail);
    out.detail("The app is healthy.");
    checkAbort();

    out.step("Starting the first sync");
    syncStarted = await startSync(deps, out, hostPort, generated.syncSecret);
  }

  // Summary.
  out.blank();
  out.info(options.noStart ? "The files are ready." : "DocMyRepos is running.");
  out.info(`  Address:      ${portal.url}`);
  out.info(`  Admin email:  ${email}`);
  if (password.generated) {
    out.revealOnce(
      "Admin password (shown once; it is also in .env until you remove it)",
      password.value,
    );
  } else {
    out.info("  Admin password: the one you entered");
  }
  if (options.noStart) {
    out.info(`  Start it:     cd ${dir} && docker compose up -d --wait`);
  } else {
    out.info(
      syncStarted
        ? `  First sync:   started; follow it at ${portal.url}/status`
        : `  First sync:   not started; the scheduler starts one shortly after boot (${portal.url}/status)`,
    );
  }
  if (created && !isPublicHttpsAddress(portal.url)) {
    out.info(
      "  Webhook:      inactive (the address is not a public https address). Syncing relies on the scheduled sync until you have one; see docs/github-app-setup.md to turn it on.",
    );
  }

  await offerCleanup({ deps, out, prompter, dir, url: portal.url, started: !options.noStart });
  return EXIT.OK;
}

function printCommands(out: Output, port: number, noStart: boolean): void {
  out.info("Commands that will run, from that folder (no shell, no secrets in arguments):");
  if (noStart) {
    out.info("  none (--no-start)");
    return;
  }
  out.info("  docker compose pull");
  out.info("  docker compose up -d --wait --wait-timeout 180");
  out.info(
    `  POST http://127.0.0.1:${port}/api/sync   (bearer secret sent as a header, not shown)`,
  );
}

function startFailed(
  out: Output,
  dir: string,
  step: string,
  message: string | undefined,
  logTail: string | undefined,
): ExitCode {
  out.error(`Failed at the step "${step}": ${message ?? "see the logs"}`);
  if (logTail !== undefined && logTail !== "") {
    out.info("Last log lines of the app:");
    for (const line of logTail.split("\n")) out.detail(line);
  }
  out.info(`The files were kept in ${dir}.`);
  out.info(`To read more: cd ${dir} && ${MORE_LOGS_COMMAND}`);
  return EXIT.FAILURE;
}

async function startSync(
  deps: RunDeps,
  out: Output,
  port: number,
  syncSecret: string,
): Promise<boolean> {
  try {
    const response = await deps.fetch(`http://127.0.0.1:${port}/api/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${syncSecret}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 200 && response.status < 300) {
      out.detail("The first sync was started.");
      return true;
    }
    out.warn(`The app answered ${response.status} when asked to start the first sync.`);
  } catch {
    out.warn("The first sync could not be started from here.");
  }
  return false;
}

async function offerCleanup(args: {
  deps: RunDeps;
  out: Output;
  prompter: Prompter;
  dir: string;
  url: string;
  started: boolean;
}): Promise<void> {
  const { deps, out, prompter, dir, url, started } = args;
  const manual = (): void => {
    out.blank();
    out.info(
      `After you sign in, remove these lines from ${join(dir, ".env")} so the password does not stay on disk:`,
    );
    for (const name of BOOTSTRAP_LINES) out.info(`  ${name}=...`);
    out.info(`Then restart the app: cd ${dir} && ${RESTART_COMMAND}`);
  };
  if (!started || !prompter.prompting) {
    manual();
    return;
  }
  out.blank();
  out.info(`Open ${url} and sign in with the admin email and password to create the first admin.`);
  const signedIn = await prompter.confirm("Have you signed in?", false);
  if (
    !signedIn ||
    !(await prompter.confirm(
      "Remove ADMIN_EMAIL and ADMIN_PASSWORD from .env and restart the app?",
      true,
    ))
  ) {
    manual();
    return;
  }
  try {
    const removed = await removeBootstrapCredentials(dir);
    out.detail(`Removed ${removed} lines from .env.`);
  } catch {
    out.warn("Could not rewrite .env.");
    manual();
    return;
  }
  const restart = await deps.runner("docker", ["compose", "up", "-d"], {
    cwd: dir,
    timeoutMs: 5 * 60_000,
  });
  if (restart.code === 0) out.detail("The app was restarted without the bootstrap credentials.");
  else out.warn(`The app was not restarted. Run it yourself: cd ${dir} && ${RESTART_COMMAND}`);
}

// ---------------------------------------------------------------------------------------------
// The GitHub App

interface AppContext {
  readonly deps: RunDeps;
  readonly out: Output;
  readonly options: Options;
  readonly prompter: Prompter;
  readonly io: PromptIo;
  readonly client: GithubClient;
  readonly orgName: string;
  readonly portalUrl: string;
}

async function askExisting(
  prompter: Prompter,
  io: PromptIo,
  env: Readonly<Record<string, string | undefined>>,
  usePresets: boolean,
): Promise<ExistingInput | undefined> {
  const preset = (name: string): { preset?: string } => {
    const value = usePresets ? env[name] : undefined;
    return value === undefined ? {} : { preset: value };
  };
  const appId = await prompter.ask({
    key: "DOCMYREPOS_APP_ID",
    label: "GitHub App id",
    ...preset("DOCMYREPOS_APP_ID"),
    validate: validateNumericId,
  });
  const keyFile = await prompter.ask({
    key: "DOCMYREPOS_APP_KEY_FILE",
    label: "Path of the App's private key file (.pem)",
    ...preset("DOCMYREPOS_APP_KEY_FILE"),
    validate: nonEmpty,
  });
  let webhookSecret: string | undefined;
  const given = usePresets ? env.DOCMYREPOS_WEBHOOK_SECRET : undefined;
  if (prompter.prompting) {
    const checked = given === undefined ? undefined : validateSharedSecret(given);
    if (checked?.ok === true) {
      webhookSecret = checked.value;
    } else {
      for (;;) {
        const typed = await io.readSecret("Webhook secret of the App (hidden): ");
        if (typed === null) throw new InputClosedError();
        const result = validateSharedSecret(typed);
        if (result.ok) {
          webhookSecret = result.value;
          break;
        }
        io.write(`${result.reason}\n`);
      }
    }
  } else {
    webhookSecret = await prompter.ask({
      key: "DOCMYREPOS_WEBHOOK_SECRET",
      label: "Webhook secret of the App",
      ...(given === undefined ? {} : { preset: given }),
      validate: validateSharedSecret,
    });
  }
  const installation = usePresets ? env.DOCMYREPOS_INSTALLATION_ID : undefined;
  const installationId =
    installation === undefined
      ? undefined
      : await prompter.ask({
          key: "DOCMYREPOS_INSTALLATION_ID",
          label: "Installation id",
          preset: installation,
          validate: validateNumericId,
        });
  if (appId === undefined || keyFile === undefined || webhookSecret === undefined) return undefined;
  return { appId, keyFile, webhookSecret, installationId };
}

/** Reads the key file, proves id and key belong together with `GET /app`, and reports permissions. */
async function validateExisting(
  context: AppContext,
  input: ExistingInput,
): Promise<AppCredentials> {
  const { out, client, prompter, deps } = context;
  let text: string;
  try {
    text = await readFile(resolve(deps.cwd, input.keyFile), "utf8");
  } catch {
    throw new AppInputError(
      "The private key file could not be read. Check the path and that you can read the file.",
    );
  }
  const pem = normalizePem(text);
  out.redactor.add(pem);
  const problem = pemProblem(pem);
  if (problem !== null) throw new AppInputError(`The private key file ${problem}.`);
  const token = createAppJwt(input.appId, pem);
  out.redactor.add(token);
  const info = await client.getApp(token);
  out.detail(`Found the GitHub App "${info.name}".`);
  const warnings = detectPermissionWarnings(info.permissions);
  if (warnings.length > 0) {
    for (const warning of warnings) out.warn(warning);
    if (!prompter.prompting) {
      throw new AppInputError(
        "The App's permissions are not read-only contents and metadata. Fix them in the App's settings, or run again without --yes to confirm.",
      );
    }
    if (!(await prompter.confirm("Use this App anyway?", false))) {
      throw new AppInputError("The App was not accepted.");
    }
  }
  return {
    appId: info.id,
    slug: info.slug,
    name: info.name,
    pem,
    webhookSecret: input.webhookSecret,
  };
}

async function resolveExistingApp(
  context: AppContext,
  first: ExistingInput,
): Promise<{ app: AppCredentials; installationId: number | undefined }> {
  const { out, prompter, io, deps } = context;
  let input = first;
  for (;;) {
    try {
      const app = await validateExisting(context, input);
      return { app, installationId: input.installationId };
    } catch (error) {
      if (
        !(error instanceof AppInputError || error instanceof GithubError) ||
        !prompter.prompting
      ) {
        throw error;
      }
      out.error(error.message);
      if (!(await prompter.confirm("Enter the values again?", true))) throw new Stop(EXIT.FAILURE);
      input = must(await askExisting(prompter, io, deps.env, false));
    }
  }
}

type CreateAttempt = { kind: "app"; app: AppCredentials } | { kind: "manual" } | { kind: "retry" };

async function createApp(
  context: AppContext,
): Promise<{ app: AppCredentials; created: boolean; installationId: number | undefined }> {
  const { out } = context;
  for (;;) {
    const attempt = await attemptCreate(context);
    if (attempt.kind === "app") {
      return { app: attempt.app, created: true, installationId: undefined };
    }
    if (attempt.kind === "retry") continue;
    out.info("Create the App by hand and enter its values:");
    out.info(`  Guide: ${SETUP_GUIDE_URL} (section 5a)`);
    const input = must(await askExisting(context.prompter, context.io, context.deps.env, false));
    const result = await resolveExistingApp(context, input);
    return { app: result.app, created: false, installationId: result.installationId };
  }
}

const PASTE_PROBLEMS = {
  empty: "Nothing was entered.",
  "not-a-code": "That is not a code or an address.",
  "no-code": "That address has no code in it.",
  "state-mismatch":
    "That address is from a different attempt. Start again from the printed address.",
} as const;

async function askPastedCode(context: AppContext, state: string): Promise<string | undefined> {
  const { io } = context;
  for (;;) {
    const line = await io.readLine(
      "Paste the code, or the whole address from the browser's address bar (Enter to give up): ",
    );
    if (line === null) throw new InputClosedError();
    if (line.trim() === "") return undefined;
    const parsed = parsePastedCode(line, state);
    if (parsed.ok) return parsed.code;
    io.write(`${PASTE_PROBLEMS[parsed.reason]}\n`);
  }
}

async function attemptCreate(context: AppContext): Promise<CreateAttempt> {
  const { deps, out, options, prompter, client, orgName, portalUrl } = context;
  const callback: ManifestCallbackHandle = await startManifestCallback({
    organization: orgName,
    manifest: (redirectUrl) => buildManifest({ organization: orgName, portalUrl, redirectUrl }),
    signal: deps.signal,
    ...(deps.timing?.callbackTimeoutMs === undefined
      ? {}
      : { timeoutMs: deps.timing.callbackTimeoutMs }),
    openBrowser: options.noBrowser ? () => Promise.resolve(false) : deps.openBrowser,
  });
  try {
    out.info(
      "GitHub will ask you to confirm a read-only App (contents and metadata read access, private, not public).",
    );
    if (callback.opened) {
      out.info("Your browser was opened. Confirm the App on GitHub, then come back here.");
      out.info(`If it did not open, use this address: ${callback.startUrl}`);
    } else {
      out.info(`Open this address in your browser: ${callback.startUrl}`);
    }

    let code: string | undefined;
    if (options.noBrowser) {
      code = await askPastedCode(context, callback.state);
    } else {
      try {
        code = (await callback.result).code;
      } catch (error) {
        if (!(error instanceof ManifestCallbackError) || error.reason === "aborted") throw error;
        out.warn(error.message);
        if (
          await prompter.confirm("Paste the code from the browser's address bar instead?", true)
        ) {
          code = await askPastedCode(context, callback.state);
        }
        if (code === undefined) {
          return (await prompter.confirm("Try creating the App again?", false))
            ? { kind: "retry" }
            : { kind: "manual" };
        }
      }
    }
    if (code === undefined) return { kind: "manual" };

    let converted;
    try {
      converted = await client.convertManifest(code);
    } catch (error) {
      if (error instanceof GithubError && error.kind === "manifest_rejected") {
        out.warn(error.message);
        return { kind: "manual" };
      }
      throw error;
    }
    out.redactor.add(converted.pem);
    out.redactor.add(converted.webhookSecret);
    const problem = pemProblem(converted.pem);
    if (problem !== null) throw new AppInputError(`The private key GitHub returned ${problem}.`);
    out.detail(`Created the GitHub App "${converted.name}".`);
    return {
      kind: "app",
      app: {
        appId: converted.id,
        slug: converted.slug,
        name: converted.name,
        pem: normalizePem(converted.pem),
        webhookSecret: converted.webhookSecret,
      },
    };
  } finally {
    await callback.close();
  }
}

async function waitForInstallation(
  context: AppContext,
  app: AppCredentials,
  jwt: () => string,
): Promise<number> {
  const { deps, out, options, prompter, orgName } = context;
  const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
  let announced = "";
  const onPoll = (lookup: InstallationLookup): void => {
    if (lookup.status === "wrong_account") {
      const key = lookup.accounts.join(",");
      if (key !== announced) {
        announced = key;
        out.warn(
          `The App is installed on ${lookup.accounts.join(", ")} but not on ${orgName}. Install it on ${orgName}.`,
        );
      }
    }
  };
  // Already installed (an existing App, or a re-run): no need to send the user to GitHub.
  const existing = findInstallation(await context.client.listInstallations(jwt()), orgName);
  if (existing.status === "found") {
    out.detail(`Found the installation on ${existing.login}.`);
    return existing.id;
  }
  onPoll(existing);
  for (;;) {
    out.info(`Install the App on ${orgName}: ${installUrl}`);
    if (prompter.prompting && !options.noBrowser)
      await deps.openBrowser(installUrl).catch(() => false);
    out.info("Waiting for the installation...");
    const result = await context.client.waitForInstallation(jwt, {
      organization: orgName,
      onPoll,
      signal: deps.signal,
      ...(deps.timing?.installationTimeoutMs === undefined
        ? {}
        : { timeoutMs: deps.timing.installationTimeoutMs }),
      ...(deps.timing?.installationIntervalMs === undefined
        ? {}
        : { intervalMs: deps.timing.installationIntervalMs }),
    });
    if (result.status === "found") {
      out.detail(`Found the installation on ${result.login}.`);
      return result.id;
    }
    if (result.status === "aborted") throw new InterruptedError();
    out.warn(`The App was not installed on ${orgName} in time.`);
    if (!prompter.prompting) throw new Stop(EXIT.FAILURE);
    if (await prompter.confirm("Keep waiting (the install page is opened again)?", true)) continue;
    return must(
      await prompter.ask({
        key: "installation id",
        label: "Installation id (the number at the end of the installation's settings address)",
        validate: validateNumericId,
      }),
    );
  }
}

async function pickRepositories(
  context: AppContext,
  jwt: () => string,
  installationId: number,
): Promise<Repos> {
  const { out, client, prompter } = context;
  const token = await client.createInstallationToken(jwt(), installationId);
  out.redactor.add(token);
  const list = await client.listRepositories(token);
  if (list.names.length === 0) {
    out.warn(
      `The installation can access no repository yet. Add repositories in the App's installation settings on GitHub (Settings, GitHub Apps, Configure on ${context.orgName}). All repositories it can access later are synced.`,
    );
    return "all";
  }
  out.detail(
    `The App can access ${list.total} repositories${list.truncated ? ` (showing the first ${list.names.length})` : ""}.`,
  );
  if (await prompter.confirm(`Include all ${list.total} repositories?`, true)) return "all";
  out.info(`Available: ${list.names.join(", ")}`);
  const known = new Set(list.names);
  return must(
    await prompter.ask({
      key: "repositories",
      label: "Repositories to include (comma-separated names)",
      validate: (input) => {
        const parsed = parseRepositoryList(input);
        if (!parsed.ok) return parsed;
        const unknown = parsed.value.filter((name) => !known.has(name));
        return unknown.length > 0
          ? { ok: false, reason: `The App cannot access: ${unknown.join(", ")}.` }
          : parsed;
      },
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Dry run

async function dryRun(args: {
  deps: RunDeps;
  out: Output;
  options: Options;
  prompter: Prompter;
  client: GithubClient;
  host: HostInfo;
  dir: string;
  tag: string;
  hostPort: number;
  appRoute: string;
  orgName: string;
  portal: string;
  existingInput: ExistingInput | undefined;
  reposAnswer: Repos | undefined;
}): Promise<ExitCode> {
  const { deps, out, options, prompter, client, host, dir, hostPort } = args;
  out.step("GitHub App");
  if (args.appRoute === "create") {
    out.info(
      `Would open your browser to GitHub to create a read-only App (contents and metadata read access) for ${args.orgName}, then wait for you to install it.`,
    );
    out.info("Nothing is created in a dry run.");
  } else {
    const context: AppContext = {
      deps,
      out,
      options,
      prompter,
      io: redactingIo(deps.io, out.redactor),
      client,
      orgName: args.orgName,
      portalUrl: args.portal,
    };
    const app = await validateExisting(context, must(args.existingInput));
    if (args.existingInput?.installationId === undefined) {
      const installations = await client.listInstallations(createAppJwt(app.appId, app.pem));
      const lookup = findInstallation(installations, args.orgName);
      out.info(
        lookup.status === "found"
          ? `The App is installed on ${lookup.login}.`
          : `The App is not installed on ${args.orgName} yet; a real run would wait for it.`,
      );
    }
  }
  out.info(
    args.reposAnswer === undefined
      ? "Repositories: all, or chosen from the list once the App is installed."
      : `Repositories: ${args.reposAnswer === "all" ? "all" : args.reposAnswer.join(", ")}`,
  );
  const layout = chooseKeyLayout(host);
  const files = [
    { path: "docker-compose.yml", mode: 0o644, secret: false },
    { path: ".env", mode: 0o600, secret: true },
    { path: "docmyrepos.config.yml", mode: 0o644, secret: false },
    { path: ".gitignore", mode: 0o644, secret: false },
    ...(layout.layout === "file"
      ? [{ path: "github-app.private-key.pem", mode: 0o600, secret: true }]
      : []),
  ];
  out.step("Plan");
  out.info(`Image tag: ${args.tag}`);
  for (const line of summarizeFiles(
    dir,
    files,
    `The private key would be stored ${layout.layout === "file" ? "as a file" : "inline in .env"}: ${layout.reason}`,
  )) {
    out.info(line);
  }
  printCommands(out, hostPort, options.noStart);
  out.blank();
  out.info("Dry run finished. Nothing was written, created or started.");
  return EXIT.OK;
}

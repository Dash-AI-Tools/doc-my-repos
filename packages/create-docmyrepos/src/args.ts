import { parseArgs } from "node:util";

/**
 * The command line, as one table. The parser, the help text and the tests that check the help
 * all read this list, so a flag cannot exist without being documented.
 *
 * No flag takes a secret: those come only from the environment variables in `ENV_VARS` (or a file
 * they point to), so nothing secret lands in shell history or in `ps`.
 */
export interface FlagSpec {
  readonly name: string;
  readonly short?: string;
  readonly type: "boolean" | "string";
  /** Placeholder for the value in the help text. */
  readonly value?: string;
  readonly description: string;
}

export const FLAGS: readonly FlagSpec[] = [
  {
    name: "dir",
    type: "string",
    value: "<path>",
    description: "Folder to install into (default ./docmyrepos). Same as the positional argument.",
  },
  { name: "org", type: "string", value: "<name>", description: "GitHub organization." },
  {
    name: "url",
    type: "string",
    value: "<address>",
    description:
      "Address the portal is reached at (default http://localhost:3000; https for public hosts).",
  },
  {
    name: "port",
    type: "string",
    value: "<number>",
    description: "Host port, published on 127.0.0.1 only (default 3000).",
  },
  { name: "admin-email", type: "string", value: "<email>", description: "First admin's email." },
  {
    name: "repos",
    type: "string",
    value: "all|a,b,c",
    description: "Repositories to include: all the App can access, or bare names (default all).",
  },
  {
    name: "app",
    type: "string",
    value: "existing|create",
    description:
      "Use an existing GitHub App, or create one in the browser (create needs a terminal).",
  },
  {
    name: "image-tag",
    type: "string",
    value: "<tag>",
    description: "Image tag to pin in docker-compose.yml (default: this installer's version).",
  },
  {
    name: "yes",
    short: "y",
    type: "boolean",
    description: "Never prompt: use the flags and environment variables, accept confirmations.",
  },
  {
    name: "dry-run",
    type: "boolean",
    description:
      "Run the checks and print the plan. Writes nothing, creates no App, starts nothing.",
  },
  {
    name: "no-start",
    type: "boolean",
    description: "Write the files but do not pull or start the containers.",
  },
  {
    name: "force",
    type: "boolean",
    description: "Back up an existing installation's files (timestamped) and replace them.",
  },
  {
    name: "no-browser",
    type: "boolean",
    description:
      "Do not launch a browser. Prints the addresses and, when creating the App, asks you to paste the code from the browser's address bar.",
  },
  { name: "help", short: "h", type: "boolean", description: "Show this help." },
  { name: "version", short: "v", type: "boolean", description: "Print the installer's version." },
];

export interface EnvVarSpec {
  readonly name: string;
  readonly description: string;
}

export const ENV_VARS: readonly EnvVarSpec[] = [
  { name: "DOCMYREPOS_ADMIN_PASSWORD", description: "First admin's password (12+ characters)." },
  { name: "DOCMYREPOS_APP_ID", description: "Existing GitHub App: the App id." },
  { name: "DOCMYREPOS_APP_KEY_FILE", description: "Existing GitHub App: path of the .pem key." },
  { name: "DOCMYREPOS_INSTALLATION_ID", description: "Existing GitHub App: installation id." },
  { name: "DOCMYREPOS_WEBHOOK_SECRET", description: "Existing GitHub App: webhook secret." },
  {
    name: "DOCMYREPOS_GITHUB_API_URL",
    description: "Testing only: a fake GitHub API on a loopback address.",
  },
];

export const EXIT_CODES: readonly { code: number; meaning: string }[] = [
  { code: 0, meaning: "success" },
  { code: 1, meaning: "failure (files already written are kept)" },
  { code: 2, meaning: "usage error or missing answers" },
  { code: 130, meaning: "interrupted" },
];

export interface Options {
  readonly dir: string | undefined;
  readonly org: string | undefined;
  readonly url: string | undefined;
  readonly port: string | undefined;
  readonly adminEmail: string | undefined;
  readonly repos: string | undefined;
  readonly app: string | undefined;
  readonly imageTag: string | undefined;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly noStart: boolean;
  readonly force: boolean;
  readonly noBrowser: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

/** A command-line mistake: reported with exit code 2. The message never contains an argument value. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseCommandLine(argv: readonly string[]): Options {
  const options: Record<string, { type: "boolean" | "string"; short?: string }> = {};
  for (const flag of FLAGS) {
    options[flag.name] =
      flag.short === undefined ? { type: flag.type } : { type: flag.type, short: flag.short };
  }
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    // Node's message names the offending option, never a value from our secrets.
    const raw = error instanceof Error ? error.message : "invalid arguments";
    const named = /Unknown option '(-{1,2}[A-Za-z0-9-]*)/.exec(raw);
    if (named !== null) throw new UsageError(`Unknown option ${named[1]}. Run with --help.`);
    const missing = /Option '([^']+)'.*argument missing/.exec(raw);
    if (missing !== null) {
      throw new UsageError(
        `The option ${missing[1]?.split(",")[0]} needs a value. Run with --help.`,
      );
    }
    throw new UsageError("The command line could not be read. Run with --help.");
  }
  const v = parsed.values as Record<string, string | boolean | undefined>;
  const str = (name: string): string | undefined => {
    const value = v[name];
    return typeof value === "string" ? value : undefined;
  };
  const flag = (name: string): boolean => v[name] === true;

  if (parsed.positionals.length > 1) {
    throw new UsageError("Only one target folder can be given. Run with --help.");
  }
  const positional = parsed.positionals[0];
  const dirFlag = str("dir");
  if (positional !== undefined && dirFlag !== undefined && positional !== dirFlag) {
    throw new UsageError("Give the target folder either as an argument or with --dir, not both.");
  }
  return {
    dir: dirFlag ?? positional,
    org: str("org"),
    url: str("url"),
    port: str("port"),
    adminEmail: str("admin-email"),
    repos: str("repos"),
    app: str("app"),
    imageTag: str("image-tag"),
    yes: flag("yes"),
    dryRun: flag("dry-run"),
    noStart: flag("no-start"),
    force: flag("force"),
    noBrowser: flag("no-browser"),
    help: flag("help"),
    version: flag("version"),
  };
}

function flagLabel(flag: FlagSpec): string {
  const short = flag.short === undefined ? "    " : `-${flag.short}, `;
  const value = flag.value === undefined ? "" : ` ${flag.value}`;
  return `${short}--${flag.name}${value}`;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function section(rows: readonly (readonly [string, string])[]): string[] {
  const column = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.flatMap(([label, description]) =>
    wrap(description, 76 - column).map(
      (text, index) => `  ${index === 0 ? label.padEnd(column) : " ".repeat(column)}${text}`,
    ),
  );
}

export function helpText(version: string): string {
  return [
    `create-docmyrepos ${version}`,
    "",
    "Sets up a DocMyRepos documentation portal: checks Docker, creates or checks a read-only",
    "GitHub App, writes docker-compose.yml, .env and docmyrepos.config.yml with generated",
    "secrets, starts it and starts the first sync. The only network traffic goes to GitHub",
    "and, through Docker, to the container registry. There is no telemetry.",
    "",
    "Usage: create-docmyrepos [folder] [options]",
    "",
    "Options:",
    ...section(FLAGS.map((f) => [flagLabel(f), f.description] as const)),
    "",
    "Environment variables (secrets are never accepted as options):",
    ...section(ENV_VARS.map((e) => [e.name, e.description] as const)),
    "",
    "Exit codes:",
    ...section(EXIT_CODES.map((e) => [String(e.code), e.meaning] as const)),
    "",
    "Without a terminal, --yes is required and every answer must come from options and",
    "environment variables; the missing ones are listed together. Creating the App needs a",
    "browser, so with --yes use --app existing.",
    "",
  ].join("\n");
}

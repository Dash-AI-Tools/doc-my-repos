/**
 * Thrown when the environment is invalid. `problems` lists one line per missing or invalid item,
 * naming the variable. It never holds a secret.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
    super(`Invalid configuration (${count}):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = Object.freeze([...problems]);
  }
}

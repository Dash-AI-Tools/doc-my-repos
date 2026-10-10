/** Shortest accepted shared secret (the sync and webhook secrets). Guessing 16 random characters is not feasible. */
export const MIN_SECRET_LENGTH = 16;

const REDACTED = "[redacted]";
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Holds a secret value (private key, webhook or sync secret, database URL) so that it never
 * shows up when the surrounding object is logged, inspected, stringified or serialized.
 * Code that needs the value calls `reveal()` explicitly.
 */
export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
    Object.freeze(this);
  }

  /** Returns the secret value. Call only where the value is used, never to log or serialize. */
  reveal(): T {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return REDACTED;
  }
}

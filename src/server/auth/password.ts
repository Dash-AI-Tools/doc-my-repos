import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const KEY_LEN = 32;

// Stored as `scrypt$<salt-hex>$<hash-hex>` (N=16384 default params).
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, KEY_LEN)) as Buffer;
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = parts[1];
  const hex = parts[2];
  if (salt === undefined || hex === undefined) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  let actual: Buffer;
  try {
    actual = (await scrypt(password, salt, KEY_LEN)) as Buffer;
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

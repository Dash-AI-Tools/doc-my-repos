import { generateKeyPairSync } from "node:crypto";

export function rsaPem(format: "pkcs1" | "pkcs8" = "pkcs1"): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: format, format: "pem" }).toString();
}

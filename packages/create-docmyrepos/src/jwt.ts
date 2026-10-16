import { createPrivateKey, sign } from "node:crypto";

import { pemProblem } from "./pem.js";

/** GitHub rejects an App JWT that lives longer than 10 minutes; use 9 plus the 60 s backdate. */
export const JWT_BACKDATE_SECONDS = 60;
export const JWT_LIFETIME_SECONDS = 9 * 60;

const base64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

/**
 * Builds the short-lived `RS256` JWT that authenticates as a GitHub App. `iat` is backdated 60
 * seconds to allow for clock drift and `exp` is 9 minutes after `now`. Throws an `Error` with a
 * fixed message (never key material) when the key is unusable.
 */
export function createAppJwt(
  appId: number | string,
  privateKeyPem: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const problem = pemProblem(privateKeyPem);
  if (problem !== null) throw new Error(`The GitHub App private key ${problem}.`);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - JWT_BACKDATE_SECONDS,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
      iss: String(appId),
    }),
  );
  const data = `${header}.${payload}`;
  let signature: Buffer;
  try {
    signature = sign("RSA-SHA256", Buffer.from(data), createPrivateKey(privateKeyPem.trim()));
  } catch {
    throw new Error("The GitHub App private key could not be used to sign.");
  }
  return `${data}.${base64url(signature)}`;
}

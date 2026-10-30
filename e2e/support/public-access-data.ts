/**
 * Constants of the public access e2e data. Plain data, no imports, like `seed-data.ts`: the specs
 * import it, `public-access-seed.ts` writes it. The `publicaccess` server runs WITHOUT the e2e auth
 * bypass, so its users have real password hashes and a spec signs in through `/api/auth/login`.
 * A request with no cookie is an anonymous visitor.
 */

export const PUBLIC_USERS = {
  admin: {
    email: "public-admin@example.com",
    password: "public-admin-password-1234",
    role: "admin",
  },
  member: {
    email: "public-member@example.com",
    password: "public-member-password-1234",
    role: "user",
  },
} as const;

export type PublicUser = keyof typeof PUBLIC_USERS;

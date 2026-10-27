export type Role = "admin" | "user";

/** A signed-in person, as `authenticate` returns it. */
export interface User {
  readonly id: number;
  readonly email: string;
  readonly role: Role;
}

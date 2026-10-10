import { defineConfig } from "drizzle-kit";

// Migration tooling reads DATABASE_URL directly; the app config loader is not involved.
// `drizzle-kit generate` does not connect, so the URL is only needed for later db commands.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});

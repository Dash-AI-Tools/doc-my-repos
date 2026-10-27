import { COMMENT_DOCS, COMMENT_USERS } from "./support/comment-data";
import { docUrl } from "./support/comments";
import { expect, test } from "./support/csp";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Every page and API behind the session gate confirms the user in the database before it reads
 * content (tenant-context "Authenticated content is confirmed per request"); the cookie signature
 * alone is not enough. The e2e servers skip the cookie check of the proxy (E2E_AUTH_BYPASS) and
 * act as the user named in `x-e2e-user`, so this asks as a user who has been disabled: the proxy
 * lets the request through, and the server must still refuse it.
 */
test.skip(SKIP_DB, SKIP_DB_REASON);

const DISABLED = { "x-e2e-user": COMMENT_USERS.dora.email };
const ACTIVE = { "x-e2e-user": COMMENT_USERS.ana.email };
const DOC = docUrl(COMMENT_DOCS.main);

test.describe("a disabled user's requests", () => {
  test.use({ baseURL: stackUrl("comments") });

  test("are redirected from a document page to the sign-in page", async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: stackUrl("comments"),
      extraHTTPHeaders: DISABLED,
    });
    const page = await context.newPage();
    await page.goto(DOC);
    await expect(page).toHaveURL(/\/login$/);
    await context.close();
  });

  test("are answered 401 by the search API, while an active user's are answered", async ({
    request,
  }) => {
    const refused = await request.get("/api/search?q=install", { headers: DISABLED });
    expect(refused.status()).toBe(401);
    expect(await refused.json()).toEqual({ error: "Unauthorized" });
    const answered = await request.get("/api/search?q=install", { headers: ACTIVE });
    expect(answered.status()).toBe(200);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SETUP_HREF, SetupBanner } from "./setup-banner";

describe("SetupBanner", () => {
  it("is one link to the configuration page that opens the instructions", () => {
    const html = renderToStaticMarkup(<SetupBanner />);
    expect(html).toContain(`href="${SETUP_HREF}"`);
    expect(html).toContain("Connect DocMyRepos to GitHub");
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});

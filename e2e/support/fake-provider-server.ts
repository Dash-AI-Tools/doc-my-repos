import { startFakeProvider } from "../../src/server/ask/testing/fake-provider";
import { FAKE_PROVIDER_PORT } from "./stack";

/**
 * The fake model provider for the Ask e2e stack, run as one of Playwright's web servers (see
 * `playwright.config.ts`). It speaks the OpenAI chat completions protocol on a fixed loopback
 * port, which the `ask` app server gets as `AI_OPENAI_BASE_URL`, and is scripted by the specs over
 * `/__control/` (see `e2e/support/ask.ts`). No real provider is ever called.
 */
void startFakeProvider({ port: FAKE_PROVIDER_PORT }).then((provider) => {
  console.log(`[e2e] fake model provider on ${provider.origin}`);
  const stop = () => void provider.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
});

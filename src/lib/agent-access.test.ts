import { describe, expect, it } from "vitest";

import {
  EXPIRY_OPTIONS,
  TOKEN_PLACEHOLDER,
  connectionSnippets,
  displayPrefix,
  formatWhen,
  mcpAddress,
} from "./agent-access";

describe("mcpAddress", () => {
  it("is the portal origin followed by /api/mcp", () => {
    expect(mcpAddress("https://docs.example.com")).toBe("https://docs.example.com/api/mcp");
    expect(mcpAddress("http://localhost:3000")).toBe("http://localhost:3000/api/mcp");
  });

  it("does not double a trailing slash, and falls back to the bare path before the origin is known", () => {
    expect(mcpAddress("https://docs.example.com/")).toBe("https://docs.example.com/api/mcp");
    expect(mcpAddress("")).toBe("/api/mcp");
  });
});

describe("connectionSnippets", () => {
  const address = "https://docs.example.com/api/mcp";

  it("carries a placeholder, never a token, unless one is passed in", () => {
    const { commandLine, json } = connectionSnippets(address);
    expect(commandLine).toContain(TOKEN_PLACEHOLDER);
    expect(json).toContain(TOKEN_PLACEHOLDER);
    expect(commandLine + json).not.toMatch(/dmr_/);
  });

  it("builds the Claude Code command with the address and the bearer header", () => {
    const { commandLine } = connectionSnippets(address);
    expect(commandLine).toBe(
      `claude mcp add --transport http docmyrepos '${address}' --header 'Authorization: Bearer YOUR_TOKEN'`,
    );
  });

  it("builds JSON that parses, with the url and the authorization header", () => {
    const parsed = JSON.parse(connectionSnippets(address).json) as unknown;
    expect(parsed).toEqual({
      mcpServers: {
        docmyrepos: { url: address, headers: { Authorization: "Bearer YOUR_TOKEN" } },
      },
    });
  });

  it("fills in the token it is given, in both snippets", () => {
    const token = `dmr_${"A".repeat(43)}`;
    const { commandLine, json } = connectionSnippets(address, token);
    expect(commandLine).toContain(`Bearer ${token}`);
    expect(commandLine).not.toContain(TOKEN_PLACEHOLDER);
    expect(JSON.parse(json).mcpServers.docmyrepos.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it("quotes the shell command so an odd address cannot add a command", () => {
    const { commandLine } = connectionSnippets("https://x.example/a'; touch pwned; '/api/mcp");
    expect(commandLine).toContain(`'https://x.example/a'\\''; touch pwned; '\\''/api/mcp'`);
    // The only unquoted words are the fixed ones.
    expect(commandLine.replace(/'(?:[^']|'\\'')*'/g, "''")).toBe(
      "claude mcp add --transport http docmyrepos '' --header ''",
    );
  });
});

describe("display helpers", () => {
  it("shows a prefix as dmr_ and the first characters", () => {
    expect(displayPrefix("abcd1234")).toBe("dmr_abcd1234…");
  });

  it("formats an ISO time in UTC and an empty one as nothing", () => {
    expect(formatWhen("2026-10-16T09:30:00.000Z")).toBe("16 Oct 2026, 09:30 UTC");
    expect(formatWhen(null)).toBe("");
  });

  it("offers exactly the three expiries the server accepts", () => {
    expect(EXPIRY_OPTIONS.map((o) => o.days)).toEqual([30, 90, 365]);
  });
});

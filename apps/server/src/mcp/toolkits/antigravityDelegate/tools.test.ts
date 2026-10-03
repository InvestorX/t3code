import { describe, expect, it } from "vite-plus/test";

import { PullRequestsCoreToolkit, PullRequestsToolkit } from "../pullRequests/tools.ts";
import { AntigravityDelegateToolkit } from "./tools.ts";

describe("Antigravity delegate MCP registration", () => {
  it("keeps the delegate isolated from the pull-request core toolkit", () => {
    expect(Object.keys(PullRequestsCoreToolkit.tools)).toEqual([
      "link_pull_request",
      "unlink_pull_request",
      "list_thread_pull_requests",
    ]);
    expect(Object.keys(AntigravityDelegateToolkit.tools)).toEqual(["antigravity_delegate"]);
  });

  it("merges the delegate into the toolkit bundle already registered by McpHttpServer", () => {
    expect(Object.keys(PullRequestsToolkit.tools)).toEqual([
      "link_pull_request",
      "unlink_pull_request",
      "list_thread_pull_requests",
      "antigravity_delegate",
    ]);
  });
});

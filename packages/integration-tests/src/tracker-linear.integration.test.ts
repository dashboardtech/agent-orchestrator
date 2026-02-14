/**
 * Integration tests for the Linear tracker plugin.
 *
 * Requires:
 *   - LINEAR_API_KEY set (direct Linear API access)
 *   - LINEAR_TEAM_ID set (team to create test issues in)
 *
 * Skipped automatically when prerequisites are missing.
 *
 * Each test run creates a real Linear issue, exercises the plugin methods
 * against it, and deletes it in cleanup. This validates that our GraphQL
 * queries, state mapping, and data parsing work against the real API —
 * not just against mocked responses.
 */

import { request } from "node:https";
import type { ProjectConfig } from "@agent-orchestrator/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import trackerLinear from "@agent-orchestrator/plugin-tracker-linear";

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const LINEAR_API_KEY = process.env["LINEAR_API_KEY"];
const LINEAR_TEAM_ID = process.env["LINEAR_TEAM_ID"];
const canRun = Boolean(LINEAR_API_KEY && LINEAR_TEAM_ID);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Direct GraphQL call for test cleanup (delete issue). */
function linearGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const body = JSON.stringify({ query, variables });

  return new Promise<T>((resolve, reject) => {
    const url = new URL("https://api.linear.app/graphql");
    const req = request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: LINEAR_API_KEY!,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf-8");
            const json = JSON.parse(text) as {
              data?: T;
              errors?: Array<{ message: string }>;
            };
            if (json.errors?.length) {
              reject(new Error(`Linear API error: ${json.errors[0].message}`));
              return;
            }
            resolve(json.data as T);
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("Linear API request timed out"));
    });

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("tracker-linear (integration)", () => {
  const tracker = trackerLinear.create();

  const project: ProjectConfig = {
    name: "test-project",
    repo: "test-org/test-repo",
    path: "/tmp/test",
    defaultBranch: "main",
    sessionPrefix: "test",
    tracker: {
      plugin: "linear",
      teamId: LINEAR_TEAM_ID!,
    },
  };

  // Issue state tracked across tests (created in beforeAll, cleaned up in afterAll)
  let issueIdentifier: string; // e.g. "INT-1234"
  let issueUuid: string; // Linear internal UUID (needed for deletion)

  // -------------------------------------------------------------------------
  // Setup — create a test issue
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    const result = await tracker.createIssue!(
      {
        title: `[AO Integration Test] ${new Date().toISOString()}`,
        description:
          "Automated integration test issue. Safe to delete if found lingering.",
        priority: 4, // Low
      },
      project,
    );

    issueIdentifier = result.id;

    // Resolve the UUID for cleanup — the plugin uses identifiers (INT-1234)
    // but deletion requires the UUID
    const data = await linearGraphQL<{ issue: { id: string } }>(
      `query($id: String!) { issue(id: $id) { id } }`,
      { id: issueIdentifier },
    );
    issueUuid = data.issue.id;
  }, 30_000);

  // -------------------------------------------------------------------------
  // Cleanup — archive the test issue so it doesn't clutter the board
  // -------------------------------------------------------------------------

  afterAll(async () => {
    if (issueUuid) {
      try {
        await linearGraphQL(
          `mutation($id: String!) {
            issueUpdate(id: $id, input: { trashed: true }) {
              success
            }
          }`,
          { id: issueUuid },
        );
      } catch {
        // Best-effort cleanup
      }
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // Test cases
  // -------------------------------------------------------------------------

  it("createIssue returns a well-shaped Issue", () => {
    // Validating the result captured in beforeAll
    expect(issueIdentifier).toBeDefined();
    expect(issueIdentifier).toMatch(/^[A-Z]+-\d+$/);
  });

  it("getIssue fetches the created issue with correct fields", async () => {
    const issue = await tracker.getIssue(issueIdentifier, project);

    expect(issue.id).toBe(issueIdentifier);
    expect(issue.title).toContain("[AO Integration Test]");
    expect(issue.description).toContain("Automated integration test");
    expect(issue.url).toMatch(/^https:\/\/linear\.app\//);
    expect(issue.state).toBe("open");
    expect(Array.isArray(issue.labels)).toBe(true);
    expect(issue.priority).toBe(4);
  });

  it("isCompleted returns false for an open issue", async () => {
    const completed = await tracker.isCompleted(issueIdentifier, project);
    expect(completed).toBe(false);
  });

  it("issueUrl returns a valid Linear URL", () => {
    const url = tracker.issueUrl(issueIdentifier, project);
    expect(url).toContain(issueIdentifier);
    expect(url).toMatch(/^https:\/\/linear\.app\//);
  });

  it("branchName returns conventional branch name", () => {
    const branch = tracker.branchName(issueIdentifier, project);
    expect(branch).toBe(`feat/${issueIdentifier}`);
  });

  it("generatePrompt includes issue details", async () => {
    const prompt = await tracker.generatePrompt(issueIdentifier, project);

    expect(prompt).toContain(issueIdentifier);
    expect(prompt).toContain("[AO Integration Test]");
    expect(prompt).toContain("Priority: Low");
    expect(prompt).toContain("implement the changes");
  });

  it("listIssues includes the created issue", async () => {
    const issues = await tracker.listIssues!(
      { state: "open", limit: 50 },
      project,
    );

    const found = issues.find((i) => i.id === issueIdentifier);
    expect(found).toBeDefined();
    expect(found!.title).toContain("[AO Integration Test]");
  });

  it("updateIssue adds a comment", async () => {
    await tracker.updateIssue!(
      issueIdentifier,
      { comment: "Integration test comment" },
      project,
    );

    // Verify the comment was added by fetching comments directly
    const data = await linearGraphQL<{
      issue: { comments: { nodes: Array<{ body: string }> } };
    }>(
      `query($id: String!) {
        issue(id: $id) {
          comments { nodes { body } }
        }
      }`,
      { id: issueIdentifier },
    );

    const commentBodies = data.issue.comments.nodes.map((c) => c.body);
    expect(commentBodies).toContain("Integration test comment");
  });

  it("updateIssue closes the issue and isCompleted reflects it", async () => {
    await tracker.updateIssue!(
      issueIdentifier,
      { state: "closed" },
      project,
    );

    const completed = await tracker.isCompleted(issueIdentifier, project);
    expect(completed).toBe(true);

    const issue = await tracker.getIssue(issueIdentifier, project);
    expect(issue.state).toBe("closed");
  });

  it("updateIssue reopens the issue", async () => {
    await tracker.updateIssue!(
      issueIdentifier,
      { state: "open" },
      project,
    );

    const completed = await tracker.isCompleted(issueIdentifier, project);
    expect(completed).toBe(false);

    const issue = await tracker.getIssue(issueIdentifier, project);
    expect(issue.state).toBe("open");
  });
});

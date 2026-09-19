/**
 * MCP round trip: a real client handshakes with the real server over a
 * linked in-memory transport, lists tools, and calls both of them.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { MockBackend } from "../src/backends/mock.js";
import { createServer } from "../src/server.js";

async function connectedClient(backend = new MockBackend()) {
  const server = createServer(backend);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("MCP server", () => {
  it("exposes exactly jev_judge and jev_gate", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["jev_gate", "jev_judge"]);
  });

  it("answers a jev_judge call end to end", async () => {
    const client = await connectedClient(
      new MockBackend({
        pass: { answer: 0.97 },
        next: {
          answer: "commit",
          distribution: { commit: 0.92, debug: 0.08 },
          confidence: 0.92,
        },
      }),
    );
    const res = await client.callTool({
      name: "jev_judge",
      arguments: {
        state: "CI: 128 tests passed, 0 failed",
        questions: [
          { id: "pass", type: "noul", question: "Did all tests pass?" },
          {
            id: "next",
            type: "choice",
            question: "Next step?",
            options: ["commit", "debug"],
          },
        ],
      },
    });
    const text = (res.content as { type: string; text: string }[])[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.escalated).toBe(false);
    expect(parsed.verdicts[0].answer).toBe(0.97);
    expect(parsed.verdicts[1].answer).toBe("commit");
  });

  it("carries escalation through a jev_judge call", async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "jev_judge",
      arguments: {
        state: "some state",
        questions: [
          { type: "choice", question: "Write a commit message for this diff" },
        ],
      },
    });
    const parsed = JSON.parse(
      (res.content as { type: string; text: string }[])[0].text,
    );
    expect(parsed.escalated).toBe(true);
    expect(parsed.verdicts[0].reason).toBe("open_ended");
  });

  it("answers a jev_gate call", async () => {
    const client = await connectedClient(
      new MockBackend({
        gate: {
          answer: "allow",
          distribution: { allow: 0.95, deny: 0.05 },
          confidence: 0.95,
        },
      }),
    );
    const res = await client.callTool({
      name: "jev_gate",
      arguments: {
        state: "running the project's own test suite",
        tool: "Bash",
        input: "npm test",
      },
    });
    const parsed = JSON.parse(
      (res.content as { type: string; text: string }[])[0].text,
    );
    expect(parsed.decision).toBe("allow");
  });
});

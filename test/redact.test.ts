/**
 * What a gated action may carry off the machine. Two halves: the rules
 * themselves, and the guarantee at the boundary — nothing a gate sends to a
 * backend contains a credential.
 */

import { describe, expect, it } from "vitest";
import { gate } from "../src/judge.js";
import { redactSecrets } from "../src/redact.js";
import type { BackendRequest, BackendResponse, JevBackend } from "../src/backends/types.js";

describe("redactSecrets", () => {
  it("keeps ordinary commands byte-for-byte", () => {
    const plain = [
      "npm test -- --run",
      "git commit -m 'gate: keep the reason typed'",
      "rm -rf node_modules && npm ci",
      "curl -s https://api.example.com/health | jq .status",
      "psql postgres://db.internal:5432/orders -c 'select count(*) from orders'",
      "ssh deploy@box-3 'systemctl restart hostd'",
    ].join("\n");
    expect(redactSecrets(plain)).toBe(plain);
  });

  it("strips the password from a connection URL, keeping user and host", () => {
    expect(redactSecrets("psql postgres://app:hunter2@db.internal:5432/orders")).toBe(
      "psql postgres://app:[redacted]@db.internal:5432/orders",
    );
  });

  it("strips auth and cookie headers, quoted or in JSON", () => {
    expect(
      redactSecrets(`curl -H "Authorization: Bearer sk-live-4f9c2a7b1e6d8c3a" https://api.example.com/v1/me`),
    ).toBe(`curl -H "Authorization: Bearer [redacted]" https://api.example.com/v1/me`);
    expect(redactSecrets(`{"headers":{"Cookie":"session=9c1f2b"}}`)).toBe(
      `{"headers":{"Cookie":"[redacted]"}}`,
    );
  });

  it("strips credential flags, keeping the username", () => {
    expect(redactSecrets("curl -u deploy:s3cr3t https://registry.example.com")).toBe(
      "curl -u deploy:[redacted] https://registry.example.com",
    );
    expect(redactSecrets("mysqldump --password=hunter2 orders")).toBe(
      "mysqldump --password=[redacted] orders",
    );
    expect(redactSecrets("gh auth login --with-token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3")).toBe(
      "gh auth login --with-token [redacted]",
    );
  });

  it("strips secret-looking assignments", () => {
    expect(redactSecrets("PGPASSWORD=hunter2 psql -h db.internal")).toBe(
      "PGPASSWORD=[redacted] psql -h db.internal",
    );
    expect(redactSecrets(`{"api_key": "9c1f2b7d4e", "model": "jev-latest"}`)).toBe(
      `{"api_key": "[redacted]", "model": "jev-latest"}`,
    );
  });

  it("strips known key shapes wherever they appear", () => {
    const text = [
      "export OPENAI_KEY=sk-proj-9c1f2b7d4e6a8c0b2d4f",
      "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE",
      "curl -d token=xoxb-4f9c2a7b1e6d",
      "echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP",
    ].join("\n");
    const redacted = redactSecrets(text);
    for (const secret of ["9c1f2b7d4e6a8c0b2d4f", "IOSFODNN7EXAMPLE", "4f9c2a7b1e6d", "dBjftJeZ4CVP"]) {
      expect(redacted).not.toContain(secret);
    }
    // The shape stays readable: which kind of key it was, and the command around it.
    expect(redacted).toContain("sk-proj-[redacted]");
    expect(redacted).toContain("aws configure set");
  });

  it("keeps JSON-encoded tool input parseable", () => {
    const input = JSON.stringify({
      command: `curl -H "Authorization: Bearer sk-live-9c1f2b7d4e6a8c0b" https://api.example.com/v1/purge`,
      description: "purge the cache",
    });
    const redacted = redactSecrets(input);
    expect(redacted).not.toContain("9c1f2b7d4e6a8c0b");
    expect(JSON.parse(redacted).command).toBe(
      `curl -H "Authorization: Bearer [redacted]" https://api.example.com/v1/purge`,
    );
  });

  it("leaves a reference to a secret alone — there is nothing in it to leak", () => {
    const referenced = "curl -H \"Authorization: Bearer $GITHUB_TOKEN\" https://api.github.com/user";
    expect(redactSecrets(referenced)).toBe(referenced);
    expect(redactSecrets("PGPASSWORD=$DB_PASSWORD psql")).toBe("PGPASSWORD=$DB_PASSWORD psql");
  });
});

describe("gate", () => {
  it("sends no credential from the proposed action, and judges it all the same", async () => {
    let seenState = "";
    const spy: JevBackend = {
      name: "spy",
      async judge(request: BackendRequest): Promise<BackendResponse> {
        seenState = String(request.state);
        return {
          answers: [{ answer: "deny", distribution: { allow: 0.05, deny: 0.95 }, confidence: 0.95 }],
        };
      },
    };

    const result = await gate(spy, {
      state: "deploying orders-api",
      action: {
        tool: "Bash",
        input: "psql postgres://app:hunter2@db.internal/orders -c 'drop table orders'",
        description: "clear the table, auth with token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3",
      },
    });

    expect(seenState).not.toContain("hunter2");
    expect(seenState).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2M3");
    // Everything the answer depends on survived.
    expect(seenState).toContain("postgres://app:[redacted]@db.internal/orders");
    expect(seenState).toContain("drop table orders");
    expect(result.decision).toBe("deny");
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorHttpServer, McpConnectorService } from "./server.ts";

test("connector health advertises independent egress without opening a session", async () => {
  const service = new McpConnectorService();
  const http = createConnectorHttpServer(service, { host: "127.0.0.1", port: 0 });
  const url = await new Promise<string>((resolve, reject) => {
    http.server.once("error", reject);
    http.server.listen(0, "127.0.0.1", () => {
      const address = http.server.address();
      if (!address || typeof address === "string") return reject(new Error("missing address"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  try {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", sessions: 0, independentEgress: true });
  } finally {
    await http.close();
  }
});

test("connector rejects credential-bearing endpoints before network access", async () => {
  const service = new McpConnectorService();
  await assert.rejects(
    service.openSession({ taskId: "task", runtimeId: "runtime", connection: { connectionId: "c", endpoint: "https://user:pass@example.com/mcp" } }),
    /credential-free/,
  );
});

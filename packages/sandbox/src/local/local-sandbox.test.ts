import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalSandbox } from "./local-sandbox.ts";

test("LocalSandbox.exec can keep stdin open for runtime responses", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "dofe-agent-local-sandbox-stdin-"));
  const scriptPath = join(workDir, "interactive.sh");
  await writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      "IFS= read -r first",
      "printf '%s\\n' \"first:$first\"",
      "IFS= read -r second",
      "printf '%s\\n' \"second:$second\"",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(scriptPath, 0o755);

  try {
    const sandbox = new LocalSandbox(workDir, "runtime-local-stdin-test");
    let wroteFollowup = false;
    const result = await sandbox.exec({
      command: scriptPath,
      input: "hello\n",
      keepStdinOpen: true,
      onReady: (controller) => {
        setTimeout(() => {
          wroteFollowup = true;
          controller.writeStdin("world\n");
          controller.closeStdin();
        }, 10);
      },
      timeoutMs: 1_000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(wroteFollowup, true);
    assert.match(result.stdout, /first:hello/);
    assert.match(result.stdout, /second:world/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

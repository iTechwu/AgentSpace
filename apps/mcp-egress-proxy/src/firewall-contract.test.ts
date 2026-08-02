import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const reconcileScript = new URL("../../../deploy/daemon/reconcile-runtime-egress.sh", import.meta.url).pathname;

test("firewall apply installs a first-position jump into a fail-closed owned chain", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "dofe-egress-firewall-"));
  const fakeIptables = join(tempDir, "iptables");
  const commandLog = join(tempDir, "commands.log");
  writeFileSync(fakeIptables, `#!/usr/bin/env bash
echo "$*" >> "$COMMAND_LOG"
if [[ "$*" == "-n -L DOCKER-USER --line-numbers" ]]; then
  echo "3 ACCEPT all -- 0.0.0.0/0 0.0.0.0/0 /* dofe:mcp-egress:legacy */"
  exit 0
fi
if [[ "$*" == "-n -L DOCKER-USER" ]]; then exit 0; fi
if [[ "$*" == "-n -L DOFE-MCP-EGRESS" || "$*" == "-n -L DOFE-MCP-EGRESS6" ]]; then exit 1; fi
exit 0
`);
  chmodSync(fakeIptables, 0o755);

  try {
    const result = spawnSync("bash", [reconcileScript, "apply"], {
      encoding: "utf8",
      env: {
        ...process.env,
        COMMAND_LOG: commandLog,
        IPTABLES: fakeIptables,
        IP6TABLES: fakeIptables,
        RUNTIME_SUBNET: "172.20.0.0/16",
        PROXY_RUNTIME_IP: "172.20.0.2",
        CONTROL_PLANE_IPV4: "198.51.100.10",
        MODELS_GATEWAY_IPV4: "198.51.100.11",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = readFileSync(commandLog, "utf8");
    assert.match(commands, /-D DOCKER-USER 3/);
    assert.match(commands, /-N DOFE-MCP-EGRESS/);
    assert.match(commands, /-A DOFE-MCP-EGRESS -j DROP/);
    assert.match(commands, /-I DOCKER-USER 1 -s 172\.20\.0\.0\/16 -j DOFE-MCP-EGRESS/);
    assert.doesNotMatch(commands, /ip6tables.*172\.20\.0\.0/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("firewall remove deletes owned jumps without shell local-scope errors", () => {
  const source = readFileSync(reconcileScript, "utf8");
  assert.doesNotMatch(source, /while .*iptables.*-C/);
  assert.match(source, /delete_owned_chain "\$IPTABLES" "\$OWNED_CHAIN"/);
  assert.doesNotMatch(source, /-A "\$CHAIN" .*default-drop/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(
  new URL("../../../deploy/daemon/Dockerfile.managed-node", import.meta.url),
  "utf8",
);

test("managed-node image installs a checksum-pinned multi-arch cosign binary", () => {
  assert.match(dockerfile, /ARG COSIGN_VERSION=v\d+\.\d+\.\d+/);
  assert.match(dockerfile, /amd64\) COSIGN_SHA256=[a-f0-9]{64}/);
  assert.match(dockerfile, /arm64\) COSIGN_SHA256=[a-f0-9]{64}/);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, /COPY --from=cosign-download \/usr\/local\/bin\/cosign \/usr\/local\/bin\/cosign/);
});

test("managed-node image does not embed shared data-plane services", () => {
  assert.doesNotMatch(dockerfile, /FROM\s+(?:postgres|redis|rabbitmq)(?::|\s)/i);
});

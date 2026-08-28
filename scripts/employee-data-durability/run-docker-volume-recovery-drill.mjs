import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runId = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const prefix = `dofe-ead-drill-${runId}`;
const firstVolume = `${prefix}-state-v1`;
const rebuiltVolume = `${prefix}-state-v2`;
const firstImage = `dofe/ead-drill:${runId}-v1`;
const secondImage = `dofe/ead-drill:${runId}-v2`;
const firstContainer = `${prefix}-runtime-v1`;
const secondContainer = `${prefix}-runtime-v2`;
const rebuiltContainer = `${prefix}-runtime-rebuilt`;
const temporaryRoot = mkdtempSync(join(tmpdir(), `${prefix}-`));
const casRoot = join(temporaryRoot, "cas");
const manifestPath = join(temporaryRoot, "manifest.json");
const evidencePath = process.argv[2]
  ? resolve(process.argv[2])
  : join(repositoryRoot, "docs/0801/employee-data-durability/evidence", `d07-d08-${runId}.json`);
const baseImage = process.env.DOFE_EAD_DRILL_BASE_IMAGE?.trim() || "dofe/agent-runtime-codex:latest";
const imagePlatform = process.env.DOFE_EAD_DRILL_PLATFORM?.trim() || "linux/amd64";
const createdContainers = [firstContainer, secondContainer, rebuiltContainer];
const createdVolumes = [firstVolume, rebuiltVolume];
const createdImages = [firstImage, secondImage];
const phases = [];

function docker(args, options = {}) {
  const output = execFileSync(process.env.DOCKER_BIN?.trim() || "docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 180_000,
  });
  return typeof output === "string" ? output.trim() : "";
}

function exists(kind, name) {
  try {
    docker([kind, "inspect", name]);
    return true;
  } catch {
    return false;
  }
}

function removeContainer(name) {
  if (exists("container", name)) docker(["container", "rm", "--force", name]);
}

function removeVolume(name) {
  if (exists("volume", name)) docker(["volume", "rm", name]);
}

function removeImage(name) {
  if (exists("image", name)) docker(["image", "rm", "--force", name]);
}

function buildImage(image, revision) {
  docker([
    "build",
    "--platform", imagePlatform,
    "--pull=false",
    "--build-arg", `BASE_IMAGE=${baseImage}`,
    "--build-arg", `DRILL_IMAGE_REVISION=${revision}`,
    "--tag", image,
    "--file", "deploy/drills/Dockerfile.employee-runtime-recovery",
    "deploy/drills",
  ], { capture: false, timeout: 300_000 });
  return docker(["image", "inspect", "--format", "{{.Id}}", image]);
}

function runWorker({ container, image, volume, phase, downloaded, reused, requiredExisting = "" }) {
  docker([
    "run",
    "--platform", imagePlatform,
    "--name", container,
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
    "--mount", `type=volume,src=${volume},dst=/home/dofe-agent`,
    "--mount", `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    "--mount", `type=bind,src=${temporaryRoot},dst=/drill,readonly`,
    "--workdir", "/workspace",
    "--entrypoint", "node",
    image,
    "--experimental-strip-types",
    "scripts/employee-data-durability/runtime-volume-worker.mjs",
    phase,
    String(downloaded),
    String(reused),
    requiredExisting,
  ], { capture: false });
  const output = docker(["container", "logs", container]);
  const result = JSON.parse(output.split("\n").filter(Boolean).at(-1));
  const containerId = docker(["container", "inspect", "--format", "{{.Id}}", container]);
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  phases.push({ ...result, container, containerId, image, imageId, volume });
}

function writeEvidence(status, error) {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    drill: "D-07/D-08",
    status,
    runId,
    checkedAt: new Date().toISOString(),
    baseImage,
    imagePlatform,
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
    phases,
    assertions: {
      d07OldContainerDestroyed: !exists("container", firstContainer),
      d07NewImageUsed: phases[0]?.imageId !== phases[1]?.imageId,
      d07StateVolumeReusedWithoutCasFetch: phases[1]?.fetchCount === 0 && phases[1]?.reusedBlobs === 2,
      d08OriginalVolumeDestroyed: !exists("volume", firstVolume),
      d08EmptyVolumeRestoredFromCas: phases[2]?.fetchCount === 2 && phases[2]?.downloadedBlobs === 2,
      temporaryResourcesCleaned: [
        ...createdContainers.map((name) => exists("container", name)),
        ...createdVolumes.map((name) => exists("volume", name)),
        ...createdImages.map((name) => exists("image", name)),
      ].every((present) => !present),
    },
    error,
  }, null, 2)}\n`);
}

try {
  mkdirSync(casRoot, { recursive: true });
  const fixtures = [
    { path: "documents/plan.txt", bytes: Buffer.from("durable-plan-v1\n") },
    { path: "state/checkpoint.json", bytes: Buffer.from('{"generation":7,"status":"committed"}\n') },
  ];
  const files = fixtures.map((fixture) => {
    const sha256 = createHash("sha256").update(fixture.bytes).digest("hex");
    writeFileSync(join(casRoot, sha256), fixture.bytes);
    return { path: fixture.path, sha256, size: fixture.bytes.byteLength, mode: "0600" };
  });
  writeFileSync(manifestPath, JSON.stringify({
    revisionId: `revision-${runId}`,
    manifestDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
  }));

  docker(["version"]);
  const firstImageId = buildImage(firstImage, "v1");
  const secondImageId = buildImage(secondImage, "v2");
  if (firstImageId === secondImageId) throw new Error("drill images must have distinct image ids");

  docker(["volume", "create", firstVolume]);
  runWorker({ container: firstContainer, image: firstImage, volume: firstVolume, phase: "d07-before", downloaded: 2, reused: 0 });
  removeContainer(firstContainer);
  if (exists("container", firstContainer)) throw new Error("D-07 old container still exists");
  runWorker({
    container: secondContainer,
    image: secondImage,
    volume: firstVolume,
    phase: "d07-after",
    downloaded: 0,
    reused: 2,
    requiredExisting: "/home/dofe-agent/work/d07-before/documents/plan.txt",
  });
  removeContainer(secondContainer);

  removeVolume(firstVolume);
  if (exists("volume", firstVolume)) throw new Error("D-08 original state volume still exists");
  docker(["volume", "create", rebuiltVolume]);
  runWorker({ container: rebuiltContainer, image: secondImage, volume: rebuiltVolume, phase: "d08-after", downloaded: 2, reused: 0 });
  removeContainer(rebuiltContainer);

  for (const volume of createdVolumes) removeVolume(volume);
  for (const image of createdImages) removeImage(image);

  writeEvidence("passed");
  process.stdout.write(`${JSON.stringify({ status: "passed", runId, evidencePath, phases })}\n`);
} catch (error) {
  writeEvidence("failed", error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  for (const container of createdContainers) removeContainer(container);
  for (const volume of createdVolumes) removeVolume(volume);
  for (const image of createdImages) removeImage(image);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

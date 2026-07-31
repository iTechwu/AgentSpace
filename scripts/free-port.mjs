import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const port = Number(process.argv[2] ?? 1455);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Expected a valid TCP port, received: ${process.argv[2]}`);
}

async function listeningPids() {
  try {
    const { stdout } = await execFileAsync("lsof", [
      `-tiTCP:${port}`,
      "-sTCP:LISTEN",
    ]);

    return [...new Set(stdout.split(/\s+/).filter(Boolean).map(Number))];
  } catch (error) {
    if (error.code === 1) {
      return [];
    }

    throw error;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const pids = await listeningPids();

if (pids.length > 0) {
  console.log(`Stopping process(es) listening on port ${port}: ${pids.join(", ")}`);
  pids.forEach((pid) => process.kill(pid, "SIGTERM"));

  for (let attempt = 0; attempt < 20 && pids.some(isRunning); attempt += 1) {
    await wait(100);
  }

  const remainingPids = pids.filter(isRunning);
  remainingPids.forEach((pid) => process.kill(pid, "SIGKILL"));
}

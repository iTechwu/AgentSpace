import { spawn } from "node:child_process";

export async function runDevCommand(args: string[]): Promise<number> {
  const [target, ...rest] = args;

  if (target !== "web") {
    console.error("Usage: dofe-agent dev web [--port <n>] [--hostname <host>]");
    return 1;
  }

  const forwardedArgs = ["--dir", "apps/web", "run", "dev", "--"];
  if (rest.length > 0) {
    forwardedArgs.push(...rest);
  } else {
    forwardedArgs.push("--hostname", "0.0.0.0", "--port", "1455");
  }

  const child = spawn("pnpm", forwardedArgs, {
    stdio: "inherit",
  });

  return await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => {
      console.error("Failed to start pnpm. Ensure pnpm is installed and available on PATH.");
      resolve(1);
    });
  });
}

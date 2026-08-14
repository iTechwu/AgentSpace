#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { printRemoteDaemonHelp, runRemoteDaemonCommand } from "./remote-daemon.ts";
// Single source of truth for the daemon version; esbuild inlines this at bundle time.
import daemonPackageJson from "../package.json" with { type: "json" };

export async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printRemoteDaemonHelp();
    return 0;
  }

  if (args[0] === "--version" || args[0] === "version") {
    console.log(daemonPackageJson.version);
    return 0;
  }

  const [command, ...restArgs] = args;
  return runRemoteDaemonCommand(command, restArgs);
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
}

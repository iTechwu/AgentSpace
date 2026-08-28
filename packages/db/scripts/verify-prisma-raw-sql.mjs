import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const prismaRoot = fileURLToPath(new URL("../src/prisma", import.meta.url));
const unsafePattern = /\$(?:queryRaw|executeRaw)Unsafe\b/g;

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(path));
    } else if (entry.isFile() && /\.(?:ts|mts|cts|js|mjs)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const findings = [];
for (const file of await listSourceFiles(prismaRoot)) {
  const source = await readFile(file, "utf8");
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (unsafePattern.test(line)) {
      findings.push(`${relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`);
    }
    unsafePattern.lastIndex = 0;
  });
}

if (findings.length > 0) {
  console.error("Unsafe Prisma raw SQL API detected:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log("Prisma raw SQL guard passed: no Unsafe API found in packages/db/src/prisma.");
}

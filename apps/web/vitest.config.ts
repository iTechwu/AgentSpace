import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Tests share one local workspace-state database; file parallelism causes seed/version races.
    fileParallelism: false,
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: `${path.resolve(__dirname, ".")}/$1` },
      { find: /^@dofe-agent\/domain$/, replacement: path.resolve(__dirname, "../../packages/domain/src/index.ts") },
      { find: /^@dofe-agent\/domain\/(.*)$/, replacement: `${path.resolve(__dirname, "../../packages/domain/src")}/$1.ts` },
      { find: /^@dofe-agent\/services$/, replacement: path.resolve(__dirname, "../../packages/services/src/index.ts") },
      { find: /^@dofe-agent\/services\/(.*)$/, replacement: `${path.resolve(__dirname, "../../packages/services/src")}/$1.ts` },
      { find: /^@dofe-agent\/db$/, replacement: path.resolve(__dirname, "../../packages/db/src/index.ts") },
      { find: /^@dofe-agent\/db\/(.*)$/, replacement: `${path.resolve(__dirname, "../../packages/db/src")}/$1.ts` },
      { find: /^@dofe-agent\/db\/index$/, replacement: path.resolve(__dirname, "../../packages/db/src/index.ts") },
      { find: /^@dofe-agent\/db\/database$/, replacement: path.resolve(__dirname, "../../packages/db/src/database.ts") },
      { find: /^dofe-agent-daemon$/, replacement: path.resolve(__dirname, "../../packages/daemon/src/index.ts") },
      { find: /^dofe-agent-daemon\/agent-router$/, replacement: path.resolve(__dirname, "../../packages/daemon/src/agent-router/index.ts") },
      { find: /^dofe-agent-daemon\/daemon-client$/, replacement: path.resolve(__dirname, "../../packages/daemon/src/daemon-client.ts") },
    ],
  },
});

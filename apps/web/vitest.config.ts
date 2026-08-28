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
      { find: /^@\/(.*)$/, replacement: `${path.resolve(import.meta.dirname, ".")}/$1` },
      { find: /^@dofe-agent\/domain$/, replacement: path.resolve(import.meta.dirname, "../../packages/domain/src/index.ts") },
      { find: /^@dofe-agent\/domain\/(.*)$/, replacement: `${path.resolve(import.meta.dirname, "../../packages/domain/src")}/$1.ts` },
      { find: /^@dofe-agent\/services$/, replacement: path.resolve(import.meta.dirname, "../../packages/services/src/index.ts") },
      // 域 barrel 子路径在测试环境指回根 barrel：vi.mock("@dofe-agent/services") 才能拦截
      // SUT 的域导入（32 个测试文件 mock 根模块）。生产构建走 package.json exports 按域收窄，不受影响。
      { find: /^@dofe-agent\/services\/(workflows|skills|employees|workspace|mcp-center|models|runtime|integrations|openmontage|capabilities|channels|messaging|tasks|collaboration|knowledge|documents|content|finance|operations|conversations)$/, replacement: path.resolve(import.meta.dirname, "../../packages/services/src/index.ts") },
      { find: /^@dofe-agent\/services\/(.*)$/, replacement: `${path.resolve(import.meta.dirname, "../../packages/services/src")}/$1.ts` },
      { find: /^@dofe-agent\/db$/, replacement: path.resolve(import.meta.dirname, "../../packages/db/src/index.ts") },
      { find: /^@dofe-agent\/db\/(.*)$/, replacement: `${path.resolve(import.meta.dirname, "../../packages/db/src")}/$1.ts` },
      { find: /^@dofe-agent\/db\/index$/, replacement: path.resolve(import.meta.dirname, "../../packages/db/src/index.ts") },
      { find: /^@dofe-agent\/db\/database$/, replacement: path.resolve(import.meta.dirname, "../../packages/db/src/database.ts") },
      { find: /^dofe-agent-daemon$/, replacement: path.resolve(import.meta.dirname, "../../packages/daemon/src/index.ts") },
      { find: /^dofe-agent-daemon\/agent-router$/, replacement: path.resolve(import.meta.dirname, "../../packages/daemon/src/agent-router/index.ts") },
      { find: /^dofe-agent-daemon\/daemon-client$/, replacement: path.resolve(import.meta.dirname, "../../packages/daemon/src/daemon-client.ts") },
    ],
  },
});

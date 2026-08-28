import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(projectDir, "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: [
    "agentspace.local.dofe.ai",
    "dofe-agent.local.dofe.ai",
    "hire-an-agent.online",
    "feishu-e2e.hire-an-agent.online",
    "127.0.0.1",
    "localhost",
  ],
  devIndicators: false,
  reactStrictMode: true,
  // P1-01：产出最小 standalone 产物（.next/standalone/server.js + .next/static + public），
  // 供镜像 runtime 阶段只复制运行所需文件，避免携带完整 workspace node_modules 与源码。
  // 仍可用 next start 启动（standalone 是额外产物，不改动既有 dev/start 流程）。
  output: "standalone",
  typescript: {
    // 保留 Next 内置类型检查作为构建末道防线；prebuild 仍负责更早的依赖和 Web 类型检查。
    ignoreBuildErrors: false,
    tsconfigPath: "tsconfig.typecheck.json",
  },
  transpilePackages: [
    "@dofe-agent/db",
    "@dofe-agent/domain",
    "@dofe-agent/sandbox",
    "@dofe-agent/services",
    "@dofe/sso-node",
    "dofe-agent-daemon",
  ],
  outputFileTracingRoot: repositoryRoot,
  outputFileTracingExcludes: {
    "/*": [
      "../../.git/**/*",
      "../../.dofe-agent-record-live/**/*",
      "../../.claude/**/*",
      "../../.github/**/*",
      "../../Design/**/*",
      "../../PR/**/*",
      "../../TODO/**/*",
      "../../data/**/*",
      "../../demo/**/*",
      "../../docs/**/*",
      "../../example/**/*",
      "../../runtime-output/**/*",
      ".next/**/*",
      "e2e/**/*",
      "test/**/*",
      "test-results/**/*",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
  experimental: {
    externalDir: true,
  },
  turbopack: {
    resolveAlias: {
      "@dofe-agent/db": "../../packages/db/src/index.ts",
      "@dofe-agent/domain": "../../packages/domain/src/index.ts",
      "@dofe-agent/domain/workspace": "../../packages/domain/src/workspace.ts",
      "@dofe-agent/sandbox": "../../packages/sandbox/src/index.ts",
      "@dofe-agent/services": "../../packages/services/src/index.ts",
      "dofe-agent-daemon": "../../packages/daemon/src/index.ts",
      "dofe-agent-daemon/agent-router": "../../packages/daemon/src/agent-router/index.ts",
      "dofe-agent-daemon/daemon-client": "../../packages/daemon/src/daemon-client.ts",
    },
    root: repositoryRoot,
  },
};

export default nextConfig;

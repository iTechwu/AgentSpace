import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(projectDir, "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: [
    "dofe-agent.local.dofe.ai",
    "hire-an-agent.online",
    "feishu-e2e.hire-an-agent.online",
    "127.0.0.1",
    "localhost",
  ],
  devIndicators: false,
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
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

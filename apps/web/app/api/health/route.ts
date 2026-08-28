// 兼容入口：保持原 liveness 语义（返回 200 即进程存活），并指向分离后的
// liveness/readiness 端点。生产编排的健康检查请改用 /api/health/ready（readiness）
// 与 /api/health/live（liveness）。
export function GET(): Response {
  return Response.json({
    ok: true,
    service: "dofe-agent-web",
    live: "/api/health/live",
    ready: "/api/health/ready",
  });
}

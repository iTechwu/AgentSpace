// Liveness probe：进程存活、事件循环可响应。不做任何外部依赖检查——
// 若本路由能返回，即代表进程未退出且事件循环未被持续阻塞。
export function GET(): Response {
  return Response.json({
    ok: true,
    service: "dofe-agent-web",
    live: true,
  });
}

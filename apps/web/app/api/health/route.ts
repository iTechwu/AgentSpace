export function GET(): Response {
  return Response.json({
    ok: true,
    service: "dofe-agent-web",
  });
}

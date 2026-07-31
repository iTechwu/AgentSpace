import http from "node:http";

const port = Number.parseInt(process.env.REPRO_RESPONSES_PORT ?? "43123", 10);
const mode = process.env.REPRO_RESPONSES_MODE ?? "complete";

function writeEvent(response, event) {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function responseEnvelope(status, output = []) {
  return {
    id: "resp_repro",
    object: "response",
    created_at: 1,
    status,
    model: "repro-model",
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  };
}

const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const payload = JSON.parse(body);
    process.stdout.write(`${JSON.stringify({ mode, model: payload.model, stream: payload.stream })}\n`);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (mode === "chat_chunks") {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_repro",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_repro",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }

    const item = {
      id: "msg_repro",
      type: "message",
      status: mode === "complete" ? "completed" : "in_progress",
      role: "assistant",
      content: [{ type: "output_text", text: "OK", annotations: [] }],
    };
    writeEvent(response, { type: "response.created", response: responseEnvelope("in_progress") });
    writeEvent(response, {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    writeEvent(response, {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "OK",
    });

    if (mode === "truncated") {
      response.end();
      return;
    }

    writeEvent(response, {
      type: "response.output_item.done",
      output_index: 0,
      item,
    });
    writeEvent(response, {
      type: "response.completed",
      response: {
        ...responseEnvelope("completed", [item]),
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
      },
    });
    response.end("data: [DONE]\n\n");
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`responses-repro listening on http://127.0.0.1:${port}/v1 (${mode})\n`);
});

import {
  canReadChannelForActorSync,
  listOpenMontageChannelProjectionVersionsSync,
  readWorkspaceStateSnapshotSync,
  subscribeWorkspaceRealtimeEvents,
} from "@dofe-agent/services";
import { getWorkspaceAccessForIdentifier } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const PERSISTED_CHANNEL_POLL_MS = 750;

export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; channelName: string }> },
): Promise<Response> {
  const { workspaceId: workspaceIdentifier, channelName } = await context.params;
  const access = await getWorkspaceAccessForIdentifier(workspaceIdentifier);
  if (access.status === "unauthenticated") {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (access.status !== "ok") {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const workspaceContext = access.context;
  const workspaceId = workspaceContext.currentWorkspace.id;
  const actor = {
    userId: workspaceContext.currentUser.id,
    displayName: workspaceContext.currentUser.displayName,
    role: workspaceContext.currentMembership.role,
  };

  if (!canReadChannelForActorSync({ workspaceId, channelName, actor })) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let persistedChannelPoll: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        unsubscribe?.();
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        if (persistedChannelPoll) {
          clearInterval(persistedChannelPoll);
        }
        controller.close();
      };
      const assertStillAuthorized = () => canReadChannelForActorSync({ workspaceId, channelName, actor });
      const send = (chunk: string) => {
        if (!closed) {
          controller.enqueue(encoder.encode(chunk));
        }
      };

      send("retry: 2000\n\n");
      unsubscribe = subscribeWorkspaceRealtimeEvents(workspaceId, (event) => {
        if (event.channelName !== channelName) {
          return;
        }
        if (!assertStillAuthorized()) {
          close();
          return;
        }
        const payload =
          event.type === "channel.message.created"
            ? {
                type: event.type,
                channelName: event.channelName,
                messageId: event.messageId,
                sequence: event.sequence,
                createdAt: event.createdAt,
              }
            : event.type === "channel.thread.changed"
              ? {
                  type: event.type,
                  channelName: event.channelName,
                  sequence: event.sequence,
                  changedAt: event.changedAt,
                }
            : event.type === "openmontage.job.changed"
              ? {
                  type: event.type,
                  channelName: event.channelName,
                  jobId: event.jobId,
                  lastAppliedSequence: event.lastAppliedSequence,
                  sequence: event.sequence,
                  changedAt: event.changedAt,
                }
            : {
                type: event.type,
                channelName: event.channelName,
                taskId: event.taskId,
                eventId: event.eventId,
                sequence: event.sequence,
                createdAt: event.createdAt,
              };
        send(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
      });
      heartbeat = setInterval(() => {
        if (!assertStillAuthorized()) {
          close();
          return;
        }
        send(`: heartbeat ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);
      let persistedSignature = channelMessageSignature(workspaceId, channelName);
      let persistedJobVersions = channelJobVersions(workspaceId, channelName);
      persistedChannelPoll = setInterval(() => {
        const nextSignature = channelMessageSignature(workspaceId, channelName);
        if (nextSignature !== persistedSignature) {
          persistedSignature = nextSignature;
          send(`event: channel.thread.changed\ndata: ${JSON.stringify({
            type: "channel.thread.changed",
            channelName,
            changedAt: new Date().toISOString(),
            source: "persisted_state",
          })}\n\n`);
        }
        const nextJobVersions = channelJobVersions(workspaceId, channelName);
        for (const [jobId, version] of nextJobVersions) {
          const previous = persistedJobVersions.get(jobId);
          if (
            previous
            && previous.lastAppliedSequence === version.lastAppliedSequence
            && previous.changedAt === version.changedAt
          ) {
            continue;
          }
          send(`event: openmontage.job.changed\ndata: ${JSON.stringify({
            type: "openmontage.job.changed",
            channelName,
            jobId,
            lastAppliedSequence: version.lastAppliedSequence,
            changedAt: version.changedAt,
            source: "persisted_projection",
          })}\n\n`);
        }
        persistedJobVersions = nextJobVersions;
      }, PERSISTED_CHANNEL_POLL_MS);
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (persistedChannelPoll) {
        clearInterval(persistedChannelPoll);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

function channelMessageSignature(workspaceId: string, channelName: string): string {
  try {
    return readWorkspaceStateSnapshotSync(workspaceId)
      .messages
      .filter((message) => message.channel === channelName)
      .map((message) => `${message.id}:${message.status ?? "completed"}:${message.time}:${message.summary}`)
      .join("\u0001");
  } catch {
    // The regular client polling remains the reliability fallback if a state read is transiently unavailable.
    return "";
  }
}

function channelJobVersions(
  workspaceId: string,
  channelName: string,
): Map<string, { lastAppliedSequence: number; changedAt: string }> {
  try {
    return new Map(
      listOpenMontageChannelProjectionVersionsSync(workspaceId, channelName)
        .map((item) => [item.jobId, item] as const),
    );
  } catch {
    return new Map();
  }
}

import {
  createTaskSync,
  listTasksSync,
  updateTaskStatusSync,
} from "@dofe-agent/services";
import { listQueuedTasksSync, listTaskMessagesForTaskSync } from "@dofe-agent/db";
import { getStringFlag, parseArgs } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";

export function runTaskCommand(
  subcommand: string | undefined,
  args: string[],
  format: OutputFormat,
): number {
  if (subcommand === "list") {
    const queuedByIssueId = new Map(listQueuedTasksSync().map((task) => [task.issueId ?? "", task]));
    writeData(
      format,
      listTasksSync().map((task) => {
        const queued = queuedByIssueId.get(task.id);
        return {
          ...task,
          queueStatus: queued?.status ?? "",
          runtimeId: queued?.runtimeId ?? "",
        };
      }),
    );
    return 0;
  }

  if (subcommand === "create") {
    const { flags } = parseArgs(args);
    const title = getStringFlag(flags, "title");
    const channel = getStringFlag(flags, "channel");
    const assignee = getStringFlag(flags, "assignee");
    const priorityValue = getStringFlag(flags, "priority");
    const priority = priorityValue === "low" || priorityValue === "high" ? priorityValue : "medium";

    if (!title || !channel || !assignee) {
      console.error(
        'Usage: dofe-agent task create --title <title> --channel <name> --assignee <employee> [--priority low|medium|high] [--json]',
      );
      return 1;
    }

    const state = createTaskSync({
      title,
      channel,
      assignee,
      priority,
    });

    writeData(format, {
      ok: true,
      title,
      channel,
      assignee,
      priority,
      totalTasks: state.tasks.length,
    });
    return 0;
  }

  if (subcommand === "inspect") {
    const { flags } = parseArgs(args);
    const id = getStringFlag(flags, "id");

    if (!id) {
      console.error("Usage: dofe-agent task inspect --id <task-id> [--json]");
      return 1;
    }

    const task = listTasksSync().find((entry) => entry.id === id);
    if (!task) {
      console.error(`Task "${id}" does not exist.`);
      return 1;
    }

    const queued = listQueuedTasksSync().find((entry) => entry.issueId === id);
    const messages = queued ? listTaskMessagesForTaskSync(queued.id) : [];

    writeData(format, {
      task,
      queue: queued ?? null,
      taskMessages: messages,
    });
    return 0;
  }

  if (subcommand === "move") {
    const { flags } = parseArgs(args);
    const id = getStringFlag(flags, "id");
    const status = getStringFlag(flags, "status");

    if (!id || !status || !["todo", "in_progress", "blocked", "done"].includes(status)) {
      console.error(
        'Usage: dofe-agent task move --id <task-id> --status todo|in_progress|blocked|done [--json]',
      );
      return 1;
    }

    const state = updateTaskStatusSync(id, status as "todo" | "in_progress" | "blocked" | "done");
    writeData(format, {
      ok: true,
      id,
      status,
      totalTasks: state.tasks.length,
    });
    return 0;
  }

  console.error("Usage: dofe-agent task list [--json]");
  console.error(
    "   or: dofe-agent task create --title <title> --channel <name> --assignee <employee> [--priority low|medium|high] [--json]",
  );
  console.error(
    "   or: dofe-agent task move --id <task-id> --status todo|in_progress|blocked|done [--json]",
  );
  console.error("   or: dofe-agent task inspect --id <task-id> [--json]");
  return 1;
}

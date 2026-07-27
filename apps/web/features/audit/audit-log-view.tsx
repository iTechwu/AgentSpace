import Link from "next/link";
import type { AuditLogRecord } from "@dofe-agent/db";

export interface AuditLogFilters {
  code?: string;
  actorId?: string;
  employeeId?: string;
  runtimeId?: string;
  sessionId?: string;
  taskId?: string;
  modelId?: string;
  createdFrom?: string;
  createdTo?: string;
}

export function parseAuditLogFilters(input: Record<string, string | string[] | undefined>): AuditLogFilters {
  const read = (key: keyof AuditLogFilters) => typeof input[key] === "string" && input[key] ? String(input[key]) : undefined;
  const timestamp = (key: "createdFrom" | "createdTo") => {
    const value = read(key);
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };
  return { code: read("code"), actorId: read("actorId"), employeeId: read("employeeId"), runtimeId: read("runtimeId"), sessionId: read("sessionId"), taskId: read("taskId"), modelId: read("modelId"), createdFrom: timestamp("createdFrom"), createdTo: timestamp("createdTo") };
}

export function AuditLogView({ logs, filters, clearHref }: { logs: AuditLogRecord[]; filters: AuditLogFilters; clearHref: string }) {
  const fields: Array<[keyof AuditLogFilters, string]> = [
    ["code", "Event type"], ["actorId", "Actor"], ["employeeId", "AI employee"],
    ["runtimeId", "Runtime"], ["sessionId", "Session"], ["taskId", "Task"], ["modelId", "Model"],
  ];
  return <>
    <form method="get" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {fields.map(([name, label]) => <label key={name} className="text-xs"><span className="mb-1 block text-neutral-500">{label}</span><input name={name} defaultValue={filters[name]} className="w-full rounded border px-2 py-1.5 text-sm" /></label>)}
      <label className="text-xs"><span className="mb-1 block text-neutral-500">From</span><input type="datetime-local" name="createdFrom" defaultValue={toLocalInput(filters.createdFrom)} className="w-full rounded border px-2 py-1.5 text-sm" /></label>
      <label className="text-xs"><span className="mb-1 block text-neutral-500">To</span><input type="datetime-local" name="createdTo" defaultValue={toLocalInput(filters.createdTo)} className="w-full rounded border px-2 py-1.5 text-sm" /></label>
      <div className="col-span-2 flex items-end justify-end gap-2 lg:col-span-2"><Link href={clearHref} className="rounded border px-3 py-1.5 text-sm">Clear</Link><button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-neutral-900">Apply filters</button></div>
    </form>
    <div className="mt-4 overflow-x-auto rounded border"><table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b bg-neutral-50 text-xs text-neutral-500 dark:bg-neutral-900"><tr><th className="p-3">Time</th><th className="p-3">Event</th><th className="p-3">Title</th><th className="p-3">Note</th><th className="p-3">Context</th></tr></thead><tbody className="divide-y">{logs.map((log) => <tr key={log.id}><td className="p-3 text-xs">{new Date(log.createdAt).toLocaleString()}</td><td className="p-3 font-mono text-xs">{log.code ?? log.source}</td><td className="p-3">{log.title}</td><td className="p-3 text-neutral-500">{log.note}</td><td className="p-3"><code className="block max-w-80 whitespace-pre-wrap break-all text-xs">{formatData(log.dataJson)}</code></td></tr>)}</tbody></table>{logs.length === 0 ? <p className="p-4 text-sm text-neutral-500">No audit events match these filters.</p> : null}</div>
  </>;
}

function toLocalInput(value: string | undefined): string | undefined { return value ? value.slice(0, 16) : undefined; }
function formatData(value: string): string { try { return JSON.stringify(JSON.parse(value)); } catch { return value; } }

import { memo } from "react";
import type { WorkspaceAgentRecord } from "@/features/dashboard/data";
import { toneForStatus, translateManagementStatus } from "@/features/agents/lib/translate";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";

type TranslateFn = (zh: string, en: string) => string;

interface AgentContactSectionProps {
  readonly agents: WorkspaceAgentRecord[];
  readonly selectedAgentId: string | null;
  readonly title: string;
  readonly tx: TranslateFn;
  readonly onSelect: (agentId: string) => void;
}

export function AgentContactSection({
  agents,
  selectedAgentId,
  title,
  tx,
  onSelect,
}: AgentContactSectionProps) {
  return (
    <div className="agents-contact-section">
      <div className="agents-contact-section__label">{title}</div>
      {agents.map((agent) => (
        <AgentContactRow
          agent={agent}
          key={agent.id}
          selected={selectedAgentId === agent.id}
          tx={tx}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

const AgentContactRow = memo(function AgentContactRow({
  agent,
  selected,
  tx,
  onSelect,
}: {
  readonly agent: WorkspaceAgentRecord;
  readonly selected: boolean;
  readonly tx: TranslateFn;
  readonly onSelect: (agentId: string) => void;
}) {
  const statusTone = toneForStatus(agent.status);
  const boundLabel = agent.boundContainerName?.trim()
    || (agent.boundContainerId ? tx("已绑定 runtime", "Runtime bound") : tx("未绑定 runtime", "No runtime"));
  const metaLabel = agent.ownerDisplayName
    ? `${tx(`Owner: ${agent.ownerDisplayName}`, `Owner: ${agent.ownerDisplayName}`)} · ${boundLabel}`
    : boundLabel;

  return (
    <button
      className={`agent-contact-row agent-contact-row--${statusTone}${selected ? " agent-contact-row--active" : ""}`}
      onClick={() => onSelect(agent.id)}
      type="button"
    >
      <GeneratedAvatar
        className="agent-contact-row__avatar"
        id={agent.internalName || agent.id}
        name={agent.name}
        variant="agent"
      />
      <div className="agent-contact-row__content">
        <div className="agent-contact-row__identity">
          <div className="agent-contact-row__title">
            <strong>{agent.name}</strong>
            <span>{metaLabel}</span>
          </div>
          <span className={`agent-contact-status agent-contact-status--${statusTone}`}>
            <span className="agent-contact-dot" />
            {translateManagementStatus(agent.statusLabel || agent.status, tx)}
          </span>
        </div>
      </div>
    </button>
  );
});

import { useMemo, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import type { ContainerRecord, RuntimeGrantMember } from "@/features/dashboard/data";

interface RuntimeGrantsPanelProps {
  readonly container: ContainerRecord;
  readonly members: RuntimeGrantMember[];
  readonly pending: boolean;
  readonly onGrantRuntime: (userId: string) => void;
  readonly onRevokeRuntime: (userId: string) => void;
}

export function RuntimeGrantsPanel({
  container,
  members,
  pending,
  onGrantRuntime,
  onRevokeRuntime,
}: RuntimeGrantsPanelProps) {
  const { tx } = useLanguage();
  const [selectedUserId, setSelectedUserId] = useState("");
  const grantedUserIds = useMemo(
    () => new Set(container.grantedMembers.map((member) => member.userId)),
    [container.grantedMembers],
  );
  const availableMembers = useMemo(
    () => members.filter((member) => member.role === "member" && !grantedUserIds.has(member.userId)),
    [grantedUserIds, members],
  );

  return (
    <section className="runtime-grants-panel">
      <div className="panel-header">
        <div>
          <h3>{tx("已分配成员", "Assigned members")}</h3>
        </div>
        <span className="panel-note">{container.grantedMembers.length}</span>
      </div>

      {container.grantedMembers.length > 0 ? (
        <div className="runtime-grants-panel__list">
          {container.grantedMembers.map((member) => (
            <div className="runtime-grants-panel__row" key={member.userId}>
              <div>
                <strong>{member.displayName}</strong>
                <span>{member.primaryEmail ?? tx("成员", "Member")}</span>
              </div>
              <button
                className="modal-secondary-button"
                disabled={pending}
                onClick={() => onRevokeRuntime(member.userId)}
                type="button"
              >
                {tx("移除", "Remove")}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="runtime-grants-panel__empty">
          <strong>{tx("未分配", "Unassigned")}</strong>
          <span>{tx("还没有成员被分配到这个执行引擎。", "No members have been assigned to this execution engine yet.")}</span>
        </div>
      )}

      <form
        className="runtime-grants-panel__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!selectedUserId) {
            return;
          }
          onGrantRuntime(selectedUserId);
          setSelectedUserId("");
        }}
      >
        <label className="form-field">
          <span>{tx("分配给同事", "Assign to colleague")}</span>
          <select
            disabled={pending || availableMembers.length === 0}
            onChange={(event) => setSelectedUserId(event.currentTarget.value)}
            value={selectedUserId}
          >
            <option value="">{tx("选择成员", "Select member")}</option>
            {availableMembers.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.primaryEmail ? `${member.displayName} · ${member.primaryEmail}` : member.displayName}
              </option>
            ))}
          </select>
        </label>
        <button className="primary-button" disabled={pending || !selectedUserId} type="submit">
          {tx("分配", "Assign")}
        </button>
      </form>
    </section>
  );
}

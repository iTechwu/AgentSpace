"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { StoredWorkspaceRecord } from "@agent-space/db";
import { AppIcon } from "@/shared/ui/app-icon";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";

interface WorkspaceSwitcherProps {
  readonly currentWorkspace: StoredWorkspaceRecord;
  readonly disabled?: boolean;
  readonly organizationName?: string;
  readonly workspaces: StoredWorkspaceRecord[];
  readonly onSelect: (workspaceSlug: string) => void;
  readonly tx: (zh: string, en: string) => string;
}

export function WorkspaceSwitcher({
  currentWorkspace,
  disabled = false,
  organizationName,
  workspaces,
  onSelect,
  tx,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const canSwitch = workspaces.length > 0 && !disabled;
  const workspaceName = currentWorkspace.name.trim();
  const hierarchicalNameParts = workspaceName.split(" / ").map((part) => part.trim()).filter(Boolean);
  const hasHierarchicalName = hierarchicalNameParts.length > 1;
  const organizationLabel = organizationName?.trim();
  const groupLabel = hasHierarchicalName
    ? hierarchicalNameParts[0]
    : organizationLabel || tx("团队工作区", "Team workspaces");
  const displayName = hasHierarchicalName || organizationLabel === workspaceName
    ? workspaceName
    : `${groupLabel} / ${workspaceName}`;

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>(".workspace-switcher__trigger")?.focus();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const selected = menuRef.current?.querySelector<HTMLButtonElement>("[aria-checked='true']");
      const first = menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitemradio']");
      (selected ?? first)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']") ?? [],
    );
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  return (
    <div className="workspace-switcher" data-onboarding-target="workspace-switcher" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-busy={disabled}
        aria-label={tx("切换团队工作区", "Switch team workspace")}
        className="workspace-switcher__trigger"
        disabled={!canSwitch}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <GeneratedAvatar
          className="workspace-switcher__avatar"
          id={currentWorkspace.id}
          name={currentWorkspace.name}
          variant="system"
        />
        <span className="workspace-switcher__name" title={displayName}>{displayName}</span>
        <AppIcon className="workspace-switcher__chevron" name="chevronDown" />
      </button>

      {open ? (
        <div
          aria-label={tx("选择团队工作区", "Choose team workspace")}
          className="workspace-switcher__menu"
          onKeyDown={handleMenuKeyDown}
          ref={menuRef}
          role="menu"
        >
          <div className="workspace-switcher__menu-title">{tx("切换工作区", "Switch workspace")}</div>
          <div className="workspace-switcher__separator" />
          <div className="workspace-switcher__group-label">{groupLabel}</div>
          <div className="workspace-switcher__items">
            {workspaces.map((workspace) => {
              const selected = workspace.slug === currentWorkspace.slug;
              return (
                <button
                  aria-checked={selected}
                  className="workspace-switcher__item"
                  key={workspace.id}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) {
                      onSelect(workspace.slug);
                    }
                  }}
                  role="menuitemradio"
                  type="button"
                >
                  <GeneratedAvatar
                    className="workspace-switcher__item-avatar"
                    id={workspace.id}
                    name={workspace.name}
                    variant="system"
                  />
                  <span className="workspace-switcher__item-name">{workspace.name}</span>
                  {selected ? <AppIcon className="workspace-switcher__check" name="checkCircle" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

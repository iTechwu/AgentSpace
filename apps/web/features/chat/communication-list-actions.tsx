import { AppIcon } from "@/shared/ui/app-icon";

export interface CommunicationListTab {
  id: string;
  label: string;
  onSelect: () => void;
}

export function CommunicationListActions({
  action,
  activeTab,
  ariaLabel,
  tabs,
}: {
  action: {
    label: string;
    onClick: () => void;
  };
  activeTab: string;
  ariaLabel: string;
  tabs: CommunicationListTab[];
}) {
  return (
    <div className="conversation-list-actions">
      <div aria-label={ariaLabel} className="container-view-switch" role="tablist">
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              aria-selected={active}
              className={`container-view-switch__item${active ? " container-view-switch__item--active" : ""}`}
              disabled={active}
              key={tab.id}
              onClick={tab.onSelect}
              role="tab"
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <button
        aria-label={action.label}
        className="action-button action-button--compact action-button--icon"
        onClick={action.onClick}
        title={action.label}
        type="button"
      >
        <AppIcon name="plus" />
      </button>
    </div>
  );
}

import type { WorkspaceModuleId } from "@/features/dashboard/workspace-module-route";

type WorkspacePageLoadingProps = {
  loadingLabel?: string;
  moduleId?: WorkspaceModuleId | null;
};

export function WorkspacePageLoading({ loadingLabel, moduleId }: WorkspacePageLoadingProps) {
  return (
    <section aria-busy="true" className="page-shell workspace-page-loading" data-module={moduleId ?? "default"}>
      <WorkspacePageLoadingProgress label={loadingLabel} />
      <div aria-hidden="true" className="workspace-page-loading__content" data-testid="workspace-page-skeleton">
        {renderSkeleton(moduleId)}
      </div>
    </section>
  );
}

export function WorkspacePageLoadingProgress({ label = "Loading content" }: { label?: string }) {
  return (
    <div
      aria-label={label}
      aria-valuetext={label}
      className="workspace-page-loading__progress"
      role="progressbar"
    />
  );
}

function renderSkeleton(moduleId: WorkspaceModuleId | null | undefined) {
  if (moduleId === "im" || moduleId === "inbox" || moduleId === "contacts") {
    return <ConversationSkeleton />;
  }
  if (moduleId === "agents" || moduleId === "skills" || moduleId === "knowledge" || moduleId === "settings") {
    return <SplitPaneSkeleton />;
  }
  if (moduleId === "task-board") {
    return <BoardSkeleton />;
  }
  return <OverviewSkeleton />;
}

function OverviewSkeleton() {
  return (
    <div className="workspace-page-loading__overview">
      <div className="workspace-page-loading__header">
        <LoadingBlock className="workspace-page-loading__eyebrow" />
        <LoadingBlock className="workspace-page-loading__title" />
        <LoadingBlock className="workspace-page-loading__copy" />
      </div>
      <div className="workspace-page-loading__toolbar">
        <LoadingBlock className="workspace-page-loading__filter" />
        <LoadingBlock className="workspace-page-loading__filter workspace-page-loading__filter--short" />
        <LoadingBlock className="workspace-page-loading__action" />
      </div>
      <div className="workspace-page-loading__cards">
        <LoadingCard />
        <LoadingCard />
        <LoadingCard />
      </div>
      <div className="workspace-page-loading__rows">
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
      </div>
    </div>
  );
}

function SplitPaneSkeleton() {
  return (
    <div className="workspace-page-loading__split">
      <aside className="workspace-page-loading__rail">
        <LoadingBlock className="workspace-page-loading__rail-title" />
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
      </aside>
      <div className="workspace-page-loading__detail">
        <div className="workspace-page-loading__header">
          <LoadingBlock className="workspace-page-loading__title" />
          <LoadingBlock className="workspace-page-loading__copy" />
        </div>
        <div className="workspace-page-loading__detail-grid">
          <LoadingCard />
          <LoadingCard />
          <LoadingCard />
          <LoadingCard />
        </div>
      </div>
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div className="workspace-page-loading__conversation">
      <aside className="workspace-page-loading__rail">
        <LoadingBlock className="workspace-page-loading__rail-title" />
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
      </aside>
      <div className="workspace-page-loading__thread">
        <LoadingBlock className="workspace-page-loading__thread-title" />
        <div className="workspace-page-loading__messages">
          <LoadingBlock className="workspace-page-loading__message workspace-page-loading__message--short" />
          <LoadingBlock className="workspace-page-loading__message workspace-page-loading__message--right" />
          <LoadingBlock className="workspace-page-loading__message" />
          <LoadingBlock className="workspace-page-loading__message workspace-page-loading__message--right workspace-page-loading__message--short" />
          <LoadingBlock className="workspace-page-loading__message workspace-page-loading__message--short" />
          <LoadingBlock className="workspace-page-loading__message workspace-page-loading__message--right" />
        </div>
        <LoadingBlock className="workspace-page-loading__composer" />
      </div>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="workspace-page-loading__board">
      <div className="workspace-page-loading__header">
        <LoadingBlock className="workspace-page-loading__title" />
        <LoadingBlock className="workspace-page-loading__copy" />
      </div>
      <div className="workspace-page-loading__board-columns">
        <LoadingColumn />
        <LoadingColumn />
        <LoadingColumn />
      </div>
    </div>
  );
}

function LoadingColumn() {
  return (
    <div className="workspace-page-loading__column">
      <LoadingBlock className="workspace-page-loading__column-title" />
      <LoadingCard />
      <LoadingCard />
      <LoadingCard />
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="workspace-page-loading__card">
      <LoadingBlock className="workspace-page-loading__line workspace-page-loading__line--strong" />
      <LoadingBlock className="workspace-page-loading__line" />
      <LoadingBlock className="workspace-page-loading__line workspace-page-loading__line--short" />
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="workspace-page-loading__row">
      <LoadingBlock className="workspace-page-loading__avatar" />
      <div className="workspace-page-loading__row-copy">
        <LoadingBlock className="workspace-page-loading__line workspace-page-loading__line--strong" />
        <LoadingBlock className="workspace-page-loading__line workspace-page-loading__line--short" />
      </div>
    </div>
  );
}

function LoadingBlock({ className }: { className: string }) {
  return <span className={`workspace-page-loading__block ${className}`} />;
}

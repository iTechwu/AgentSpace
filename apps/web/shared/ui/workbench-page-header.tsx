import type { ReactNode } from "react";

interface WorkbenchPageHeaderProps {
  readonly title: string;
  readonly description: string;
  readonly eyebrow?: string;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
}

export function WorkbenchPageHeader({
  title,
  description,
  eyebrow,
  meta,
  actions,
}: WorkbenchPageHeaderProps) {
  return (
    <header className="workbench-page-header">
      <div className="workbench-page-header__copy">
        {eyebrow ? <span className="workbench-page-header__eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {meta || actions ? (
        <div className="workbench-page-header__aside">
          {meta ? <div className="workbench-page-header__meta">{meta}</div> : null}
          {actions ? <div className="workbench-page-header__actions">{actions}</div> : null}
        </div>
      ) : null}
    </header>
  );
}

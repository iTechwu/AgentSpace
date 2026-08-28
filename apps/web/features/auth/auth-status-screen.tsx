import Link from "next/link";

interface AuthStatusScreenProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly heroTitle: string;
  readonly heroBody: string;
  readonly highlights?: string[];
  readonly contextItems?: ReadonlyArray<{
    label: string;
    value: string;
  }>;
  readonly nextStepsTitle?: string;
  readonly nextSteps?: string[];
  readonly primaryAction: {
    label: string;
    href: string;
  };
  readonly secondaryAction?: {
    label: string;
    href: string;
  };
}

export function AuthStatusScreen({
  eyebrow,
  title,
  body,
  heroTitle,
  heroBody,
  highlights = [],
  contextItems = [],
  nextStepsTitle = "Next steps",
  nextSteps = [],
  primaryAction,
  secondaryAction,
}: AuthStatusScreenProps) {
  return (
    <main className="auth-shell auth-shell--status">
      <section className="auth-card auth-card--status">
        <div className="auth-status-hero">
          <p className="auth-card__eyebrow">{eyebrow}</p>
          <h1>{heroTitle}</h1>
          <p className="auth-status-hero__body">{heroBody}</p>
          {highlights.length > 0 ? (
            <ul className="auth-status-highlights">
              {highlights.map((highlight) => (
                <li key={highlight}>{highlight}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="auth-status-card">
          <h2>{title}</h2>
          <p>{body}</p>
          {contextItems.length > 0 ? (
            <dl className="auth-status-context">
              {contextItems.map((item) => (
                <div key={`${item.label}-${item.value}`}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {nextSteps.length > 0 ? (
            <>
              <h3 className="auth-status-next-steps__title">{nextStepsTitle}</h3>
              <ol className="auth-status-next-steps">
                {nextSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </>
          ) : null}
          <div className="auth-status-actions">
            <Link className="auth-button" href={primaryAction.href}>
              {primaryAction.label}
            </Link>
            {secondaryAction ? (
              <Link className="workspace-ghost-button auth-status-actions__secondary" href={secondaryAction.href}>
                {secondaryAction.label}
              </Link>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

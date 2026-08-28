interface MetaCardProps {
  readonly label: string;
  readonly value: string;
}

export function MetaCard({ label, value }: MetaCardProps) {
  return (
    <article className="meta-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

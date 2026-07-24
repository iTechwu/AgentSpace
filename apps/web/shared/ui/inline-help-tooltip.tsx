import { HoverTooltip } from "@/shared/ui/hover-tooltip";
import { AppIcon } from "@/shared/ui/app-icon";

interface InlineHelpTooltipProps {
  readonly label: string;
  readonly tooltip: string;
}

export function InlineHelpTooltip({ label, tooltip }: InlineHelpTooltipProps) {
  return (
    <HoverTooltip content={tooltip}>
      {({ describedBy, expanded, onToggle }) => (
        <button
          aria-controls={describedBy}
          aria-describedby={describedBy}
          aria-expanded={expanded}
          aria-label={label}
          className="inline-help-tooltip__button"
          onClick={onToggle}
          type="button"
        >
          <AppIcon name="info" />
        </button>
      )}
    </HoverTooltip>
  );
}

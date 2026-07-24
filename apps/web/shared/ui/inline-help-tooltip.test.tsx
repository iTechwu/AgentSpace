import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InlineHelpTooltip } from "@/shared/ui/inline-help-tooltip";

describe("InlineHelpTooltip", () => {
  it("opens on click and closes when clicked again", async () => {
    const user = userEvent.setup();

    render(<InlineHelpTooltip label="接入服务器说明" tooltip="服务器接入后会自动上报执行引擎。" />);

    const trigger = screen.getByRole("button", { name: "接入服务器说明" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("tooltip")).toHaveTextContent("服务器接入后会自动上报执行引擎。");

    await user.click(trigger);

    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

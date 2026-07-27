import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ManagedRuntimeList } from "@/features/runtimes/managed-runtime-list";

it("exposes manual credential rotation only when a runtime needs attention", async () => {
  const onRotate = vi.fn();
  const user = userEvent.setup();

  render(
    <ManagedRuntimeList
      pending={false}
      onRotate={onRotate}
      runtimes={[
        {
          id: "runtime-ready",
          name: "Ready Codex",
          provider: "codex",
          managedCredentialId: "rtc-ready-1234567890",
          status: "online",
          provisioningState: "managed",
        },
        {
          id: "runtime-attention",
          name: "Claude Worker",
          provider: "claude",
          managedCredentialId: "rtc-attention-1234567890",
          status: "offline",
          provisioningState: "needs_attention",
        },
      ]}
    />,
  );

  expect(screen.getByText("Available")).toBeInTheDocument();
  expect(screen.getByText("Needs attention")).toBeInTheDocument();
  const rotateButton = screen.getByRole("button", { name: "Rotate key" });
  await user.click(rotateButton);
  expect(onRotate).toHaveBeenCalledWith("runtime-attention");
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRevalidatePath } = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

import {
  revalidateWorkspacePath,
  revalidateWorkspacePaths,
} from "@/features/auth/workspace-revalidation";

describe("workspace revalidation", () => {
  beforeEach(() => {
    mockRevalidatePath.mockReset();
  });

  it("keeps old page path revalidation while revalidating the workspace-scoped path", () => {
    revalidateWorkspacePath("/im", "workspace-alpha");

    expect(mockRevalidatePath).toHaveBeenCalledWith("/im");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/w/workspace-alpha/im");
  });

  it("revalidates every path for legacy page fallbacks", () => {
    revalidateWorkspacePaths("workspace-alpha", ["/inbox", "/agents"]);

    expect(mockRevalidatePath).toHaveBeenCalledWith("/inbox");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/w/workspace-alpha/inbox");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/agents");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/w/workspace-alpha/agents");
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SkillPickerModal } from "@/features/agents/components/skill-picker-modal";
import { LanguageProvider } from "@/features/i18n/language-provider";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/workspace-alpha/agents",
}));

const skills: WorkspaceSkill[] = Array.from({ length: 8 }, (_, index) => ({
  id: `skill-${index + 1}`,
  name: `Skill ${index + 1}`,
  description: `Description for skill ${index + 1}.`,
  files: [],
  sourceType: "skills.sh",
  createdAt: "2026-04-10T08:00:00.000Z",
  updatedAt: "2026-04-10T08:00:00.000Z",
}));

function renderSkillPicker(onCancel = vi.fn(), onSelect = vi.fn()) {
  render(
    <LanguageProvider initialLanguage="zh">
      <SkillPickerModal pending={false} skills={skills} onCancel={onCancel} onSelect={onSelect} />
    </LanguageProvider>,
  );
  return { onCancel, onSelect };
}

describe("SkillPickerModal", () => {
  it("uses the bounded scrollable modal surface for a long skill list", () => {
    renderSkillPicker();

    const dialog = screen.getByRole("dialog", { name: "添加 Skill" });
    expect(dialog).toHaveClass("modal-card--skill-picker");
    expect(within(dialog).getAllByRole("button", { name: /Skill \d+/ })).toHaveLength(8);
  });

  it("offers an accessible close button", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderSkillPicker();

    await user.click(screen.getByRole("button", { name: "关闭添加 Skill" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

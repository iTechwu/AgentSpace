import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import { SkillDraftControls } from "./skill-draft-controls";

const { readDraft } = vi.hoisted(() => ({
  readDraft: vi.fn(),
}));

vi.mock("@/features/skills/skill-draft-actions", () => ({
  discardSkillDraftAction: vi.fn(),
  publishSkillDraftAction: vi.fn(),
  readSkillDraftAction: readDraft,
  saveSkillDraftAction: vi.fn(),
}));

function controls(skillId: string, content: string) {
  return (
    <LanguageProvider initialLanguage="zh">
      <FeedbackToastProvider>
        <SkillDraftControls
          files={[{ path: "SKILL.md", content }]}
          skillDescription="Description"
          skillId={skillId}
          skillName="Example"
        />
      </FeedbackToastProvider>
    </LanguageProvider>
  );
}

describe("SkillDraftControls", () => {
  beforeEach(() => {
    readDraft.mockReset();
    readDraft.mockResolvedValue(null);
  });

  it("does not reload draft metadata when only the file content changes", async () => {
    const view = render(controls("skill-1", "# First"));
    await waitFor(() => expect(readDraft).toHaveBeenCalledTimes(1));

    view.rerender(controls("skill-1", "# Updated"));
    expect(readDraft).toHaveBeenCalledTimes(1);

    view.rerender(controls("skill-2", "# Other"));
    await waitFor(() => expect(readDraft).toHaveBeenCalledTimes(2));
    expect(readDraft).toHaveBeenLastCalledWith({ skillId: "skill-2" });
  });
});

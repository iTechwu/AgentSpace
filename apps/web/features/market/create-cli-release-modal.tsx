"use client";

import { useId, useState } from "react";
import type { RuntimeAppArtifactKind } from "@dofe-agent/db";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import type { CreateWorkspaceRuntimeAppReleaseActionInput } from "./actions";

export function CreateCliReleaseModal(props: {
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (input: CreateWorkspaceRuntimeAppReleaseActionInput) => void;
}) {
  const { tx } = useLanguage();
  const titleId = useId();
  const descriptionId = useId();
  const [artifactKind, setArtifactKind] = useState<RuntimeAppArtifactKind>("npm");
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onCancel(); }} role="presentation">
      <form
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="modal-card modal-card--mcp-catalog"
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          props.onConfirm({
            slug: slug.trim(),
            displayName: displayName.trim(),
            description: String(values.get("description") ?? "").trim(),
            category: String(values.get("category") ?? "other"),
            homepage: String(values.get("homepage") ?? "").trim() || undefined,
            artifactKind,
            artifactName: String(values.get("artifactName") ?? "").trim(),
            version: String(values.get("version") ?? "").trim(),
            entryPoint: String(values.get("entryPoint") ?? "").trim(),
          });
        }}
      >
        <div className="modal-card__header">
          <div>
            <span className="modal-card__eyebrow">CLI Release</span>
            <h3 id={titleId}>{tx("添加工作区私有 CLI", "Add workspace-private CLI")}</h3>
            <p id={descriptionId}>{tx("只允许固定版本的 npm/PyPI 包。服务端会读取公开元数据并保存完整性摘要，不接受 shell 命令。", "Only pinned npm/PyPI packages are accepted. The server resolves public metadata and stores integrity; shell commands are never accepted.")}</p>
          </div>
          <button aria-label={tx("关闭", "Close")} className="modal-close" disabled={props.pending} onClick={props.onCancel} type="button"><AppIcon name="close" /></button>
        </div>
        <div className="modal-card__body">
          <section className="mcp-catalog-form-section" aria-labelledby={`${titleId}-identity`}>
            <div className="mcp-catalog-form-section__heading">
              <div><h4 id={`${titleId}-identity`}>{tx("产品与版本", "Product and release")}</h4><p>{tx("同一个 slug 的同一版本不可覆盖。", "A slug and version can never be overwritten.")}</p></div>
              <span className="status-chip status-chip--danger">{tx("工作区私有 · 高风险", "Private · high risk")}</span>
            </div>
            <div className="mcp-catalog-form-grid">
              <label className="form-field"><span>{tx("显示名称", "Display name")}</span><input autoFocus maxLength={120} onChange={(event) => { const value = event.currentTarget.value; setDisplayName(value); if (!slugTouched) setSlug(toSlug(value)); }} required value={displayName} /></label>
              <label className="form-field"><span>Slug</span><input maxLength={63} onChange={(event) => { setSlugTouched(true); setSlug(event.currentTarget.value.toLowerCase()); }} pattern="[a-z0-9][a-z0-9-]{0,62}" required value={slug} /></label>
              <label className="form-field"><span>{tx("类别", "Category")}</span><select defaultValue="other" name="category"><option value="developer_tools">{tx("开发工具", "Developer tools")}</option><option value="productivity">{tx("生产力", "Productivity")}</option><option value="data_analytics">{tx("数据分析", "Data analytics")}</option><option value="other">{tx("其他", "Other")}</option></select></label>
              <label className="form-field"><span>{tx("文档地址", "Documentation URL")}</span><input name="homepage" placeholder="https://docs.example.com" type="url" /></label>
              <label className="form-field form-field--full"><span>{tx("描述", "Description")}</span><textarea maxLength={600} name="description" rows={3} /></label>
            </div>
          </section>
          <section className="mcp-catalog-form-section" aria-labelledby={`${titleId}-artifact`}>
            <div className="mcp-catalog-form-section__heading"><div><h4 id={`${titleId}-artifact`}>{tx("固定包来源", "Pinned package source")}</h4><p>{tx("只访问平台允许的公共 npm registry 或 PyPI。", "Only the platform-approved public npm registry or PyPI is queried.")}</p></div></div>
            <div aria-label={tx("包管理器", "Package manager")} className="market-panel-actions" role="radiogroup">
              {(["npm", "pypi"] as const).map((kind) => <button aria-checked={artifactKind === kind} className={artifactKind === kind ? "market-tab market-tab--active" : "market-tab"} key={kind} onClick={() => setArtifactKind(kind)} role="radio" type="button">{kind === "npm" ? "npm" : "PyPI"}</button>)}
            </div>
            <div className="mcp-catalog-form-grid">
              <label className="form-field"><span>{artifactKind === "npm" ? "npm package" : "PyPI package"}</span><input name="artifactName" pattern={artifactKind === "npm" ? "(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*" : "[a-zA-Z0-9][a-zA-Z0-9._-]*"} placeholder={artifactKind === "npm" ? "@example/internal-cli" : "internal-cli"} required /></label>
              <label className="form-field"><span>{tx("固定版本", "Pinned version")}</span><input name="version" pattern={artifactKind === "npm" ? "[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?" : "[0-9]+(?:\\.[0-9]+){1,3}(?:[a-zA-Z0-9.-]+)?"} placeholder={artifactKind === "npm" ? "1.4.2" : "1.4.2rc1"} required /></label>
              <label className="form-field form-field--full"><span>{tx("入口命令", "Entrypoint")}</span><input name="entryPoint" pattern="[a-zA-Z][a-zA-Z0-9._-]{0,127}" placeholder="internal-search" required /></label>
            </div>
          </section>
          <div className="modal-card__actions"><button className="modal-secondary-button" disabled={props.pending} onClick={props.onCancel} type="button">{tx("取消", "Cancel")}</button><button className="modal-primary-button" disabled={props.pending} type="submit"><AppIcon name="plus" />{tx("校验并发布", "Validate and publish")}</button></div>
        </div>
      </form>
    </div>
  );
}

function toSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

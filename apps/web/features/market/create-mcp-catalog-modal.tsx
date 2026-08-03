"use client";

import type { McpCatalogCategory, McpRisk } from "@dofe-agent/db";
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { CreateMcpCatalogItemActionInput } from "@/features/market/mcp-actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { AppIcon } from "@/shared/ui/app-icon";

interface ToolDraft {
  id: number;
  name: string;
  description: string;
  risk: McpRisk;
  approvedByDefault: boolean;
}

interface ConfigFieldDraft {
  id: number;
  name: string;
  required: boolean;
  maxLength: string;
}

export function CreateMcpCatalogModal(props: {
  pending: boolean;
  onCancel: () => void;
  onConfirm: (input: CreateMcpCatalogItemActionInput) => void;
}) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId, descriptionId } = useDialogSurface<HTMLFormElement>(props.onCancel);
  const nextId = useRef(2);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [tools, setTools] = useState<ToolDraft[]>([
    { id: 1, name: "", description: "", risk: "medium", approvedByDefault: false },
  ]);
  const [configFields, setConfigFields] = useState<ConfigFieldDraft[]>([]);

  function addTool(): void {
    setTools((current) => [
      ...current,
      { id: nextId.current++, name: "", description: "", risk: "medium", approvedByDefault: false },
    ]);
  }

  function addConfigField(): void {
    setConfigFields((current) => [
      ...current,
      { id: nextId.current++, name: "", required: false, maxLength: "" },
    ]);
  }

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <form
        aria-describedby={descriptionId}
        aria-labelledby={labelId}
        aria-modal="true"
        className="modal-card modal-card--mcp-catalog"
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          const endpoint = String(values.get("endpoint") ?? "").trim();
          const endpointHost = new URL(endpoint).hostname;
          const allowedHosts = uniqueTokens(String(values.get("allowedHosts") ?? ""));
          if (!allowedHosts.includes(endpointHost)) allowedHosts.unshift(endpointHost);
          const declaredTools = tools.map((tool) => ({
            name: tool.name.trim(),
            description: tool.description.trim(),
            risk: tool.risk,
          }));
          const properties = Object.fromEntries(configFields.map((field) => [
            field.name.trim(),
            {
              type: "string",
              ...(field.maxLength ? { maxLength: Number(field.maxLength) } : {}),
            },
          ]));
          props.onConfirm({
            slug: slug.trim(),
            displayName: displayName.trim(),
            description: String(values.get("description") ?? "").trim(),
            version: String(values.get("version") ?? "").trim(),
            category: String(values.get("category") ?? "other") as McpCatalogCategory,
            transport: "streamable_http",
            allowedHosts,
            configurationSchema: {
              type: "object",
              properties,
              required: configFields.filter((field) => field.required).map((field) => field.name.trim()),
              additionalProperties: false,
            },
            declaredTools,
            defaultApprovedTools: tools.filter((tool) => tool.approvedByDefault).map((tool) => tool.name.trim()),
            secretFields: uniqueTokens(String(values.get("secretFields") ?? "")),
            dataDomains: uniqueTokens(String(values.get("dataDomains") ?? "")),
            risk: "high",
            endpointTemplate: endpoint,
            documentationUrl: String(values.get("documentationUrl") ?? "").trim() || undefined,
          });
        }}
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="modal-card__header">
          <div>
            <span className="modal-card__eyebrow">MCP Catalog</span>
            <h3 id={labelId}>{tx("添加 MCP 服务", "Add MCP service")}</h3>
            <p id={descriptionId}>{tx("发布一个仅当前工作区可见的不可变服务版本。", "Publish an immutable service release visible only to this workspace.")}</p>
          </div>
          <button aria-label={tx("关闭", "Close")} className="modal-close" disabled={props.pending} onClick={props.onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>

        <div className="modal-card__body">
          <section className="mcp-catalog-form-section" aria-labelledby="mcp-catalog-basics">
            <div className="mcp-catalog-form-section__heading">
              <div>
                <h4 id="mcp-catalog-basics">{tx("服务与版本", "Service and release")}</h4>
                <p>{tx("同一个 slug 与版本发布后不可覆盖。", "A published slug and version cannot be overwritten.")}</p>
              </div>
              <span className="status-chip status-chip--danger">{tx("工作区私有 · 高风险", "Private · high risk")}</span>
            </div>
            <div className="mcp-catalog-form-grid">
              <label className="form-field">
                <span>{tx("服务名称", "Service name")}</span>
                <input
                  autoFocus
                  maxLength={120}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDisplayName(value);
                    if (!slugTouched) setSlug(toSlug(value));
                  }}
                  placeholder={tx("例如：内部知识搜索", "e.g. Internal knowledge search")}
                  required
                  value={displayName}
                />
              </label>
              <label className="form-field">
                <span>Slug</span>
                <input
                  maxLength={63}
                  onChange={(event) => {
                    setSlugTouched(true);
                    setSlug(event.currentTarget.value.toLowerCase());
                  }}
                  pattern="[a-z0-9][a-z0-9-]{0,62}"
                  placeholder="internal-search"
                  required
                  value={slug}
                />
              </label>
              <label className="form-field">
                <span>{tx("版本", "Version")}</span>
                <input defaultValue="1.0.0" name="version" pattern="\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?" required />
              </label>
              <label className="form-field">
                <span>{tx("类别", "Category")}</span>
                <select defaultValue="other" name="category">
                  <option value="developer_tools">{tx("开发工具", "Developer tools")}</option>
                  <option value="productivity">{tx("生产力", "Productivity")}</option>
                  <option value="data_analytics">{tx("数据分析", "Data analytics")}</option>
                  <option value="communication">{tx("沟通", "Communication")}</option>
                  <option value="knowledge">{tx("知识", "Knowledge")}</option>
                  <option value="automation">{tx("自动化", "Automation")}</option>
                  <option value="other">{tx("其他", "Other")}</option>
                </select>
              </label>
              <label className="form-field form-field--full">
                <span>{tx("描述", "Description")}</span>
                <textarea maxLength={600} name="description" placeholder={tx("说明服务用途和可访问的数据。", "Describe the service and the data it can access.")} rows={3} />
              </label>
            </div>
          </section>

          <section className="mcp-catalog-form-section" aria-labelledby="mcp-catalog-endpoint">
            <div className="mcp-catalog-form-section__heading">
              <div>
                <h4 id="mcp-catalog-endpoint">{tx("连接与边界", "Connection and boundary")}</h4>
                <p>{tx("Runtime 只通过 daemon 任务网关访问这些允许域名。", "The runtime reaches these hosts only through the daemon task gateway.")}</p>
              </div>
              <span className="status-chip status-chip--neutral">streamable_http</span>
            </div>
            <div className="mcp-catalog-form-grid">
              <label className="form-field form-field--full">
                <span>Endpoint (HTTPS)</span>
                <input name="endpoint" pattern="https://.*" placeholder="https://mcp.example.com/mcp" required type="url" />
              </label>
              <label className="form-field form-field--full">
                <span>{tx("额外允许域名", "Additional allowed hosts")}</span>
                <input name="allowedHosts" placeholder={tx("逗号分隔；Endpoint 域名会自动加入", "Comma-separated; the endpoint host is added automatically")} />
              </label>
              <label className="form-field">
                <span>{tx("密钥字段", "Secret fields")}</span>
                <input name="secretFields" placeholder="Authorization, X-API-Key" />
              </label>
              <label className="form-field">
                <span>{tx("数据域", "Data domains")}</span>
                <input name="dataDomains" placeholder="knowledge, tickets" />
              </label>
              <label className="form-field form-field--full">
                <span>{tx("文档地址", "Documentation URL")}</span>
                <input name="documentationUrl" placeholder="https://docs.example.com/mcp" type="url" />
              </label>
            </div>
          </section>

          <section className="mcp-catalog-form-section" aria-labelledby="mcp-catalog-tools">
            <div className="mcp-catalog-form-section__heading">
              <div>
                <h4 id="mcp-catalog-tools">{tx("声明工具", "Declared tools")}</h4>
                <p>{tx("只有这里声明并获准的工具才能被任务调用。", "Tasks can call only tools declared and approved here.")}</p>
              </div>
              <button className="modal-secondary-button mcp-catalog-add-row" onClick={addTool} type="button">
                <AppIcon name="plus" />
                <span>{tx("添加工具", "Add tool")}</span>
              </button>
            </div>
            <div className="mcp-catalog-draft-list">
              {tools.map((tool, index) => (
                <div className="mcp-catalog-tool-draft" key={tool.id}>
                  <label className="form-field">
                    <span>{tx(`工具 ${index + 1}`, `Tool ${index + 1}`)}</span>
                    <input onChange={(event) => updateTool(setTools, tool.id, { name: event.currentTarget.value })} pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" placeholder="search_records" required value={tool.name} />
                  </label>
                  <label className="form-field mcp-catalog-tool-description">
                    <span>{tx("说明", "Description")}</span>
                    <input onChange={(event) => updateTool(setTools, tool.id, { description: event.currentTarget.value })} placeholder={tx("该工具执行什么操作", "What this tool does")} required value={tool.description} />
                  </label>
                  <label className="form-field">
                    <span>{tx("风险", "Risk")}</span>
                    <select onChange={(event) => updateTool(setTools, tool.id, { risk: event.currentTarget.value as McpRisk })} value={tool.risk}>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </label>
                  <label className="mcp-catalog-default-tool">
                    <input checked={tool.approvedByDefault} onChange={(event) => updateTool(setTools, tool.id, { approvedByDefault: event.currentTarget.checked })} type="checkbox" />
                    <span>{tx("默认允许", "Approve by default")}</span>
                  </label>
                  <button aria-label={tx(`移除工具 ${index + 1}`, `Remove tool ${index + 1}`)} className="mcp-catalog-remove-row" disabled={tools.length === 1} onClick={() => setTools((current) => current.filter((item) => item.id !== tool.id))} type="button">
                    <AppIcon name="trash" />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="mcp-catalog-form-section" aria-labelledby="mcp-catalog-config">
            <div className="mcp-catalog-form-section__heading">
              <div>
                <h4 id="mcp-catalog-config">{tx("非密钥配置", "Non-secret configuration")}</h4>
                <p>{tx("为连接表单声明可保存的字符串字段。", "Declare string fields that can be stored with a connection.")}</p>
              </div>
              <button className="modal-secondary-button mcp-catalog-add-row" onClick={addConfigField} type="button">
                <AppIcon name="plus" />
                <span>{tx("添加字段", "Add field")}</span>
              </button>
            </div>
            {configFields.length === 0 ? <p className="mcp-catalog-no-fields">{tx("无需额外配置。", "No additional configuration.")}</p> : null}
            <div className="mcp-catalog-draft-list">
              {configFields.map((field, index) => (
                <div className="mcp-catalog-config-draft" key={field.id}>
                  <label className="form-field">
                    <span>{tx(`字段 ${index + 1}`, `Field ${index + 1}`)}</span>
                    <input onChange={(event) => updateConfigField(setConfigFields, field.id, { name: event.currentTarget.value })} pattern="[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}" placeholder="X-Workspace" required value={field.name} />
                  </label>
                  <label className="form-field">
                    <span>{tx("最大长度", "Max length")}</span>
                    <input max={4096} min={1} onChange={(event) => updateConfigField(setConfigFields, field.id, { maxLength: event.currentTarget.value })} placeholder="4096" type="number" value={field.maxLength} />
                  </label>
                  <label className="mcp-catalog-default-tool">
                    <input checked={field.required} onChange={(event) => updateConfigField(setConfigFields, field.id, { required: event.currentTarget.checked })} type="checkbox" />
                    <span>{tx("必填", "Required")}</span>
                  </label>
                  <button aria-label={tx(`移除字段 ${index + 1}`, `Remove field ${index + 1}`)} className="mcp-catalog-remove-row" onClick={() => setConfigFields((current) => current.filter((item) => item.id !== field.id))} type="button">
                    <AppIcon name="trash" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="modal-card__footer">
          <button className="modal-secondary-button" disabled={props.pending} onClick={props.onCancel} type="button">{tx("取消", "Cancel")}</button>
          <button className="primary-button" disabled={props.pending} type="submit">
            <AppIcon name={props.pending ? "loader" : "plus"} />
            <span>{props.pending ? tx("正在发布", "Publishing") : tx("发布到目录", "Publish to catalog")}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function uniqueTokens(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)));
}

function toSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

function updateTool(
  setTools: Dispatch<SetStateAction<ToolDraft[]>>,
  id: number,
  patch: Partial<ToolDraft>,
): void {
  setTools((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
}

function updateConfigField(
  setFields: Dispatch<SetStateAction<ConfigFieldDraft[]>>,
  id: number,
  patch: Partial<ConfigFieldDraft>,
): void {
  setFields((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
}

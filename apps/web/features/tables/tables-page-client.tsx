"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { DataTablesPageData } from "@/features/dashboard/data";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import type { DataTable, DataColumnType } from "@dofe-agent/domain/workspace";
import {
  createDataTableAction,
  deleteDataTableAction,
  addDataRowAction,
  updateDataRowAction,
  deleteDataRowAction,
} from "./actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import { EmptyState } from "@/shared/ui/empty-state";

const COLUMN_TYPES: DataColumnType[] = ["text", "number", "select", "date", "person", "checkbox"];

export function TablesPageClient({ data, onDataChanged }: { data: DataTablesPageData; onDataChanged?: () => void }) {
  const { tx } = useLanguage();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createColumns, setCreateColumns] = useState<Array<{ name: string; type: DataColumnType }>>([
    { name: "", type: "text" },
  ]);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 860px)");
    const handleChange = (event?: MediaQueryListEvent): void => {
      setIsCompactLayout(event ? event.matches : mediaQuery.matches);
    };

    handleChange();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  const selected = data.tables.find((t) => t.id === selectedId);

  useEffect(() => {
    if (!isCompactLayout) {
      setMobilePane("list");
      return;
    }

    if (!selected) {
      setMobilePane("list");
    }
  }, [isCompactLayout, selected]);

  function handleCreate(): void {
    const validColumns = createColumns.filter((c) => c.name.trim());
    if (!createName.trim() || validColumns.length === 0) return;
    startTransition(async () => {
      await createDataTableAction({
        name: createName.trim(),
        columns: validColumns,
      });
      setShowCreateModal(false);
      setCreateName("");
      setCreateColumns([{ name: "", type: "text" }]);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleDelete(id: string): void {
    startTransition(async () => {
      await deleteDataTableAction(id);
      if (selectedId === id) setSelectedId(null);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleAddRow(table: DataTable): void {
    const cells: Record<string, unknown> = {};
    for (const col of table.columns) {
      cells[col.id] = col.type === "checkbox" ? false : "";
    }
    startTransition(async () => {
      await addDataRowAction(table.id, cells);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleCellChange(tableId: string, rowId: string, columnId: string, value: unknown): void {
    startTransition(async () => {
      await updateDataRowAction(tableId, rowId, { [columnId]: value });
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleDeleteRow(tableId: string, rowId: string): void {
    startTransition(async () => {
      await deleteDataRowAction(tableId, rowId);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  const showListPane = !isCompactLayout || mobilePane === "list";
  const showDetailPane = !isCompactLayout || mobilePane === "detail";

  return (
    <section className="page-shell tables-page">
      <div className={`tables-layout${isCompactLayout ? " tables-layout--compact" : ""}`}>
      {showListPane ? (
        <div className="tables-sidebar">
        <div className="tables-sidebar__header">
          <h2>{tx("数据表", "Data Tables")}</h2>
          <button
            aria-label={tx("创建数据表", "Create table")}
            className="knowledge-btn knowledge-btn--primary"
            onClick={() => setShowCreateModal(true)}
            type="button"
          >
            <AppIcon name="plus" />
          </button>
        </div>
        <div className="tables-sidebar__count">
          {tx(`${data.totalCount} 个表`, `${data.totalCount} tables`)}
        </div>
        <div className="tables-sidebar__list">
          {data.tables.map((table) => (
            <button
              className={`tables-sidebar__item${selectedId === table.id ? " tables-sidebar__item--selected" : ""}`}
              key={table.id}
              onClick={() => {
                setSelectedId(table.id);
                if (isCompactLayout) {
                  setMobilePane("detail");
                }
              }}
              type="button"
            >
              <strong>{table.name}</strong>
              <span>
                {table.columns.length} {tx("列", "cols")} · {table.rows.length} {tx("行", "rows")}
              </span>
            </button>
          ))}
          {data.tables.length === 0 ? (
            <EmptyState
              actionLabel={tx("创建数据表", "Create table")}
              body={tx("先定义列，再把结构化工作内容放进表格里。", "Start by defining columns, then add structured workspace data into the table.")}
              eyebrow={tx("数据表", "Data tables")}
              onAction={() => setShowCreateModal(true)}
              title={tx("还没有数据表", "No tables yet")}
              variant="warm"
            />
          ) : null}
        </div>
        </div>
      ) : null}

      {showDetailPane ? (
        <div className="tables-content">
        {isCompactLayout && selected ? (
          <div className="knowledge-mobile-bar">
            <button
              aria-label={tx("返回数据表列表", "Back to tables")}
              className="knowledge-mobile-bar__back"
              onClick={() => setMobilePane("list")}
              type="button"
            >
              <AppIcon name="arrowLeft" />
            </button>
            <div className="knowledge-mobile-bar__copy">
              <strong>{selected.name}</strong>
              <span>{tx("数据表详情", "Table details")}</span>
            </div>
          </div>
        ) : null}
        {selected ? (
          <div className="tables-detail">
            <div className="tables-detail__header">
              <h1>{selected.name}</h1>
              <div className="tables-detail__actions">
                <button
                  className="knowledge-btn knowledge-btn--primary"
                  disabled={isPending}
                  onClick={() => handleAddRow(selected)}
                  type="button"
                >
                  {tx("+ 添加行", "+ Add Row")}
                </button>
                <button
                  className="knowledge-btn knowledge-btn--danger"
                  disabled={isPending}
                  onClick={() => handleDelete(selected.id)}
                  type="button"
                >
                  {tx("删除表", "Delete")}
                </button>
              </div>
            </div>
            {selected.channelName ? (
              <div className="tables-detail__meta">
                {tx("关联群组", "Group")}: {selected.channelName}
              </div>
            ) : null}
            <div className="tables-grid-wrapper">
              <table className="tables-grid">
                <thead>
                  <tr>
                    {selected.columns.map((col) => (
                      <th key={col.id}>
                        {col.name}
                        <small className="tables-grid__type">{col.type}</small>
                      </th>
                    ))}
                    <th className="tables-grid__actions-col" />
                  </tr>
                </thead>
                <tbody>
                  {selected.rows.map((row) => (
                    <tr key={row.id}>
                      {selected.columns.map((col) => (
                        <td key={col.id}>
                          {col.type === "checkbox" ? (
                            <input
                              type="checkbox"
                              checked={Boolean(row.cells[col.id])}
                              onChange={(e) =>
                                handleCellChange(selected.id, row.id, col.id, e.target.checked)
                              }
                            />
                          ) : (
                            <input
                              className="tables-grid__cell-input"
                              value={String(row.cells[col.id] ?? "")}
                              onChange={(e) =>
                                handleCellChange(selected.id, row.id, col.id, e.target.value)
                              }
                            />
                          )}
                        </td>
                      ))}
                      <td className="tables-grid__actions-col">
                        <button
                          className="tables-grid__delete-row"
                          disabled={isPending}
                          onClick={() => handleDeleteRow(selected.id, row.id)}
                          type="button"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                  {selected.rows.length === 0 ? (
                    <tr>
                      <td colSpan={selected.columns.length + 1} className="tables-grid__empty">
                        {tx("没有数据行，点击添加行。", "No rows. Click + Add Row.")}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState
            body={tx("从左侧选择一个表，查看列结构并继续编辑行数据。", "Select a table to inspect its schema and continue editing rows.")}
            eyebrow={tx("数据表", "Data tables")}
            title={tx("等待选择数据表", "Choose a table")}
            variant="cool"
          />
        )}
        </div>
      ) : null}

      {showCreateModal ? (
        <div className="knowledge-modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="knowledge-modal knowledge-modal--wide" onClick={(e) => e.stopPropagation()}>
            <h3>{tx("新建数据表", "New Data Table")}</h3>
            <input
              autoFocus
              className="knowledge-modal__input"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={tx("表名称", "Table name")}
            />
            <div className="tables-create__columns">
              <label>{tx("列定义", "Columns")}</label>
              {createColumns.map((col, index) => (
                <div className="tables-create__column-row" key={index}>
                  <input
                    className="tables-create__col-name"
                    value={col.name}
                    onChange={(e) => {
                      const next = [...createColumns];
                      next[index] = { ...col, name: e.target.value };
                      setCreateColumns(next);
                    }}
                    placeholder={tx("列名", "Column name")}
                  />
                  <select
                    className="tables-create__col-type"
                    value={col.type}
                    onChange={(e) => {
                      const next = [...createColumns];
                      next[index] = { ...col, type: e.target.value as DataColumnType };
                      setCreateColumns(next);
                    }}
                  >
                    {COLUMN_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <button
                    aria-label={tx("删除列", "Remove column")}
                    className="tables-create__col-remove"
                    onClick={() => setCreateColumns(createColumns.filter((_, i) => i !== index))}
                    type="button"
                  >
                    <AppIcon name="close" />
                  </button>
                </div>
              ))}
              <button
                className="knowledge-btn knowledge-btn--ghost"
                onClick={() => setCreateColumns([...createColumns, { name: "", type: "text" }])}
                type="button"
              >
                {tx("+ 添加列", "+ Add Column")}
              </button>
            </div>
            <div className="knowledge-modal__footer">
              <button
                className="knowledge-btn knowledge-btn--primary"
                disabled={isPending || !createName.trim() || createColumns.filter((c) => c.name.trim()).length === 0}
                onClick={handleCreate}
                type="button"
              >
                {tx("创建", "Create")}
              </button>
              <button
                className="knowledge-btn knowledge-btn--ghost"
                onClick={() => setShowCreateModal(false)}
                type="button"
              >
                {tx("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </section>
  );
}

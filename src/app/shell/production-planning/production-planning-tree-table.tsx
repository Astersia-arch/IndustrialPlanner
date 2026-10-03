import { useMemo, useRef, useState, useLayoutEffect, type ReactNode, type CSSProperties } from "react";
import { cm } from "../shared";

export interface PlanningTreeRow {
  readonly id: string;
  readonly depth: number;
  readonly parentIds: readonly string[];
  readonly childIds: readonly string[];
  readonly isShared?: boolean;
}

/** 共用树表只负责交互；数量计算和供料意图分别由调用方提供。 */
export function ProductionPlanningTreeTableView<Row extends PlanningTreeRow>({
  rows, styles, className = "is-item-mode", treeScrollTop = 0, onTreeScrollTopChange = () => {},
  renderIdentity, renderRate, renderDetail, rateLabel, t,
}: {
  readonly rows: readonly Row[];
  readonly styles: Readonly<Record<string, string>>;
  readonly className?: string;
  readonly treeScrollTop?: number;
  readonly onTreeScrollTopChange?: (top: number) => void;
  readonly renderIdentity: (row: Row) => ReactNode;
  readonly renderRate?: (row: Row) => ReactNode;
  readonly renderDetail: (row: Row, rowById: ReadonlyMap<string, Row>, selectRow: (id: string) => void) => ReactNode;
  readonly rateLabel?: string;
  readonly t: (key: string) => string;
}) {
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const treePaneRef = useRef<HTMLDivElement | null>(null);
  const rowElementRefs = useRef(new Map<string, HTMLTableRowElement>());
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [collapsedRowIds, setCollapsedRowIds] = useState<Set<string>>(() => new Set());
  // 筛掉已不存在于当前树中的折叠行 ID
  const collapsibleRowIds = useMemo(
    () => new Set(rows.filter((row) => row.childIds.length > 0).map((row) => row.id)),
    [rows],
  );
  const effectiveCollapsedRowIds = useMemo(() => {
    if (collapsedRowIds.size === 0) return collapsedRowIds;
    const next = new Set<string>();
    for (const rowId of collapsedRowIds) {
      if (collapsibleRowIds.has(rowId)) next.add(rowId);
    }
    return next;
  }, [collapsedRowIds, collapsibleRowIds]);
  const visibleRows = useMemo(
    () => filterVisibleProductionPlanningTreeRows(rows, rowById, effectiveCollapsedRowIds),
    [effectiveCollapsedRowIds, rowById, rows],
  );
  const visibleRowIds = useMemo(() => new Set(visibleRows.map((row) => row.id)), [visibleRows]);
  // 确保选中行始终在可见范围内；不可见时回退到首行
  const selectedRow = useMemo(() => {
    if (selectedRowId !== null) {
      const row = rowById.get(selectedRowId);
      if (row !== undefined && visibleRowIds.has(selectedRowId)) return row;
    }
    return visibleRows[0] ?? null;
  }, [selectedRowId, rowById, visibleRowIds, visibleRows]);

  useLayoutEffect(() => {
    const element = treePaneRef.current;
    if (element === null) {
      return;
    }

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.min(treeScrollTop, maxScrollTop);
  }, [treeScrollTop, visibleRows]);

  const selectRow = (rowId: string) => {
    setSelectedRowId(rowId);
    // AI-REMOVED 2026-10-03:
    // Reason: 详情 render 回调携带 ref 闭包触发 React refs 校验。
    // Trigger: 共用树表提取。Evidence: ESLint react-hooks/refs。
    // Replacement: 下方选中行布局 effect。Risk: Low。Human Review: Required
    // Original code:
    // requestAnimationFrame(() => {
    //   rowElementRefs.current.get(rowId)?.scrollIntoView({ block: "nearest" });
    // });
  };

  useLayoutEffect(() => {
    if (selectedRowId === null) return;
    const frame = requestAnimationFrame(() => rowElementRefs.current.get(selectedRowId)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [selectedRowId]);

  const toggleRowCollapsed = (rowId: string) => {
    const row = rowById.get(rowId);
    if (row === undefined || row.childIds.length === 0) {
      return;
    }

    const nextCollapsed = !collapsedRowIds.has(rowId);
    setCollapsedRowIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });

    if (
      nextCollapsed
      && selectedRowId !== null
      && selectedRowId !== rowId
      && isProductionPlanningTreeDescendant(rowById, rowId, selectedRowId)
    ) {
      setSelectedRowId(rowId);
    }
  };

  if (rows.length === 0) {
    return <div className={cm(styles, "production-planning-empty")}>{t("productionPlanning.noRecipes")}</div>;
  }

  const layoutClassName = [
    "production-planning-tree-table-layout",
    className,
  ].join(" ");

  return (
    <div className={cm(styles, layoutClassName)}>
      <div
        className={cm(styles, "production-planning-tree-table-pane")}
        onScroll={(event) => onTreeScrollTopChange(event.currentTarget.scrollTop)}
        ref={treePaneRef}
      >
        <table className={cm(styles, "production-planning-tree-table")} style={renderRate ? undefined : { minWidth: 0 }}>
          <colgroup>
            <col className={cm(styles, "production-planning-tree-table-node-col")} />
            {renderRate ? <col className={cm(styles, "production-planning-tree-table-rate-col")} /> : null}
          </colgroup>
          <thead>
            <tr>
              <th>{t("productionPlanning.node")}</th>
              {renderRate ? <th>{rateLabel ?? t("productionPlanning.rate")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <ProductionPlanningTreeTableRow key={row.id} row={row} styles={styles}
                collapsed={collapsedRowIds.has(row.id)} selected={selectedRow?.id === row.id}
                onSelect={() => selectRow(row.id)} onToggleCollapsed={() => toggleRowCollapsed(row.id)}
                setRowElement={element => {
                  if (element) rowElementRefs.current.set(row.id, element);
                  else rowElementRefs.current.delete(row.id);
                }} renderIdentity={renderIdentity} renderRate={renderRate} t={t} />
            ))}
          </tbody>
        </table>
      </div>
      <aside className={cm(styles, "production-planning-tree-detail")}>
        {selectedRow !== null && renderDetail(selectedRow, rowById, selectRow)}
      </aside>
    </div>
  );
}


function ProductionPlanningTreeTableRow<Row extends PlanningTreeRow>({
  row, styles, collapsed, selected, onSelect, onToggleCollapsed, setRowElement, renderIdentity, renderRate, t,
}: {
  row: Row; styles: Readonly<Record<string, string>>; collapsed: boolean; selected: boolean;
  onSelect: () => void; onToggleCollapsed: () => void;
  setRowElement: (element: HTMLTableRowElement | null) => void;
  renderIdentity: (row: Row) => ReactNode; renderRate?: (row: Row) => ReactNode; t: (key: string) => string;
}) {
  const className = [
    "production-planning-tree-table-row",
    row.isShared ? "is-shared" : "",
    selected ? "is-active" : "",
  ].filter(Boolean).join(" ");

  const hasChildren = row.childIds.length > 0;
  const toggleLabel = collapsed ? t("action.expand") : t("action.collapse");

  return (
    <tr className={cm(styles, className)} ref={setRowElement}>
      <td>
        <div
          className={cm(styles, "production-planning-tree-table-node-cell")}
          style={{ "--tree-depth": row.depth } as CSSProperties}
        >
          {hasChildren ? (
            <button
              type="button"
              className={cm(styles, "production-planning-tree-table-branch-button")}
              aria-expanded={!collapsed}
              aria-label={toggleLabel}
              title={toggleLabel}
              onClick={onToggleCollapsed}
            >
              <span className={cm(styles, "production-planning-tree-table-branch")} aria-hidden="true">
                {collapsed ? "+" : "-"}
              </span>
            </button>
          ) : (
            <span className={cm(styles, "production-planning-tree-table-branch-spacer")} aria-hidden="true">
              <span className={cm(styles, "production-planning-tree-table-branch is-leaf")} />
            </span>
          )}
          <button
            type="button"
            className={cm(styles, "production-planning-tree-table-node-button")}
            aria-pressed={selected}
            onClick={onSelect}
          >
            {renderIdentity(row)}
          </button>
        </div>
      </td>
      {renderRate ? <td>{renderRate(row)}</td> : null}
    </tr>
  );
}

function filterVisibleProductionPlanningTreeRows<Row extends PlanningTreeRow>(
  rows: readonly Row[],
  rowById: ReadonlyMap<string, Row>,
  collapsedRowIds: ReadonlySet<string>,
): Row[] {
  if (collapsedRowIds.size === 0) {
    return [...rows];
  }

  const hiddenRowIds = new Set<string>();
  for (const row of rows) {
    if (hiddenRowIds.has(row.id) || !collapsedRowIds.has(row.id)) {
      continue;
    }

    collectProductionPlanningTreeDescendantIds(rowById, row.id, hiddenRowIds);
  }

  return rows.filter((row) => !hiddenRowIds.has(row.id));
}

function collectProductionPlanningTreeDescendantIds<Row extends PlanningTreeRow>(
  rowById: ReadonlyMap<string, Row>,
  rowId: string,
  result: Set<string>,
): void {
  const row = rowById.get(rowId);
  if (row === undefined) {
    return;
  }

  for (const childId of row.childIds) {
    const childRow = rowById.get(childId);
    if (childRow === undefined || childRow.parentIds.length !== 1 || result.has(childId)) {
      continue;
    }

    result.add(childId);
    collectProductionPlanningTreeDescendantIds(rowById, childId, result);
  }
}

function isProductionPlanningTreeDescendant<Row extends PlanningTreeRow>(
  rowById: ReadonlyMap<string, Row>,
  ancestorRowId: string,
  candidateRowId: string,
): boolean {
  const descendantRowIds = new Set<string>();
  collectProductionPlanningTreeDescendantIds(rowById, ancestorRowId, descendantRowIds);
  return descendantRowIds.has(candidateRowId);
}


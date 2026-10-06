import { useEffect, useRef, useState } from "react";
import { toJS } from "mobx";
import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type { BlueprintPlannerBlueprintBoundary } from "@/domain/blueprint-planner";
import type { AppHost } from "../host";
import { ItemDomainFlag } from "@/domain/shared/item-domain-flags";
import { resolveEffectiveActivityIds, isItemAvailableByActivity } from "@/shared/registry/activity-availability";
import styles from "./blueprint-planner-dialog.module.scss";

/** 边界配置只属于本次计算；关闭时取消独立识别，不修改编辑中的基地。 */
export function BlueprintIdentification({ appHost, blueprint, onBusy }: {
  appHost: AppHost; blueprint: BlueprintDocument; onBusy: (busy: boolean) => void;
}) {
  const planner = appHost.workspace.blueprintPlanner!, t = appHost.actions.translate;
  const [boundaries, setBoundaries] = useState<readonly BlueprintPlannerBlueprintBoundary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const detected = useRef<readonly BlueprintPlannerBlueprintBoundary[]>([]);
  const [activeActivityIds] = useState(() => resolveEffectiveActivityIds({ selectedActivityIds: appHost.internalState.settings.selectedActivityIds }));
  const registry = appHost.workspace.registry;
  useEffect(() => {
    const controller = new AbortController();
    void planner.actions.inspectBlueprint(blueprint, activeActivityIds, controller.signal).then(value => {
      if (!controller.signal.aborted) { detected.current = value; setBoundaries(value); }
    }).catch(error => {
      if (!controller.signal.aborted) setError(String(error instanceof Error ? error.message : error));
    });
    return () => { controller.abort(); };
  }, [planner, blueprint, activeActivityIds]);
  useEffect(() => () => abort.current?.abort(), []);
  const identify = async () => {
    if (!boundaries) return;
    const controller = new AbortController(); abort.current = controller;
    setError(null); setRunning(true); onBusy(true);
    try {
      const id = await planner.actions.identifyBlueprint({ blueprint, boundaries, activeActivityIds },
        toJS(appHost.blueprintPlannerDialog.options), controller.signal);
      appHost.blueprintPlannerDialog.selectTask(id, planner.queries.getLastRequest(id) ?? undefined);
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    finally { setRunning(false); onBusy(false); }
  };
  return <section aria-label={t("eda.identifyBlueprint")}>
    <div className={styles.heading}><p className={styles.target}>{blueprint.name}</p></div>
    <fieldset className={styles.options} disabled={running}>
      {boundaries?.map((boundary, index) => {
        const entity = blueprint.entities[boundary.entityId]!, definition = registry.queries.findEntityDefinition(entity.definitionId)!;
        const pipe = boundary.kind === "port" ? definition.portGroups.find(group => group.id === boundary.portGroupId)?.isPipe
          : definition.portGroups.some(group => group.isPipe);
        return <label key={`${boundary.entityId}/${boundary.portGroupId}/${boundary.portId}/${boundary.direction}`}>
          <span>{t(boundary.direction === "input" ? "eda.inputBoundary" : "eda.outputBoundary")} · {t(definition.nameKey)} ({entity.position.x}, {entity.position.y})</span>
          <select aria-label={`${boundary.entityId} ${boundary.direction}`} value={boundary.itemId ?? ""}
            disabled={detected.current[index]?.itemId != null}
            onChange={event => setBoundaries(boundaries!.map((entry, at) => at === index ? { ...entry, itemId: event.target.value || null } : entry))}>
            <option value="">{t("eda.chooseBoundaryItem")}</option>
            {registry.itemDefinitions.filter(item => isItemAvailableByActivity(item, activeActivityIds) && (pipe
              ? registry.queries.resolveItemDomain(item.id) !== ItemDomainFlag.Solid
              : registry.queries.resolveItemDomain(item.id) === ItemDomainFlag.Solid)).map(item => <option key={item.id} value={item.id}>{t(item.nameKey)}</option>)}
          </select>
        </label>;
      })}
    </fieldset>
    {running ? <progress aria-label={t("eda.identifyingBlueprint")} /> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    <button type="button" disabled={running || boundaries === null || !boundaries.length || boundaries.some(boundary => !boundary.itemId)}
      onClick={() => void identify()}>{t(running ? "eda.identifyingBlueprint" : "eda.identifyBlueprint")}</button>
  </section>;
}

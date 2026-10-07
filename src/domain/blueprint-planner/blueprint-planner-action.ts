import type { BlueprintPlannerRequest, BlueprintPlannerTaskFile, BlueprintPlannerBlueprintInput, BlueprintPlannerBlueprintBoundary, BlueprintPlannerOptions } from "./types/blueprint-planner-types";
import type { BlueprintDocument } from "../document/blueprint-document";

export interface BlueprintPlannerAction {
  inspectBlueprint(blueprint: BlueprintDocument, activeActivityIds: readonly string[], signal?: AbortSignal): Promise<readonly BlueprintPlannerBlueprintBoundary[]>;
  identifyBlueprint(input: BlueprintPlannerBlueprintInput, options: BlueprintPlannerOptions, signal?: AbortSignal): Promise<string>;
  deleteTask(taskId: string): Promise<void>;
  importTask(file: BlueprintPlannerTaskFile): Promise<string>;
  start(request: BlueprintPlannerRequest): string;
  continuePlanning(taskId: string, evaluationsPerRound: number, concurrency?: number | "auto", gpu?: boolean): void;
  save(taskId: string): Promise<void>;
  cancel(taskId: string): void;
  retrySave(taskId: string): Promise<void>;
}

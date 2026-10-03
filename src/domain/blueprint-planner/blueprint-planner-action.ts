import type { BlueprintPlannerRequest, BlueprintPlannerTaskFile } from "./types/blueprint-planner-types";

export interface BlueprintPlannerAction {
  deleteTask(taskId: string): Promise<void>;
  importTask(file: BlueprintPlannerTaskFile): Promise<string>;
  start(request: BlueprintPlannerRequest): string;
  continuePlanning(taskId: string, evaluationsPerRound: number, concurrency?: number): void;
  save(taskId: string): Promise<void>;
  cancel(taskId: string): void;
  retrySave(taskId: string): Promise<void>;
}

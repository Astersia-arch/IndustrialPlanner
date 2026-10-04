import type { BlueprintPlannerProgress, BlueprintPlannerRequest, BlueprintPlannerResult, BlueprintPlannerTaskFile } from "./types/blueprint-planner-types";

export interface BlueprintPlannerQuery {
  listTasks(): readonly BlueprintPlannerProgress[];
  exportTask(taskId: string): BlueprintPlannerTaskFile;
  exportDraft(request: BlueprintPlannerRequest): BlueprintPlannerTaskFile;
  getTask(taskId?: string): BlueprintPlannerProgress | null;
  getLastRequest(taskId?: string): BlueprintPlannerRequest | null;
  getResult(taskId: string): BlueprintPlannerResult | null;
}

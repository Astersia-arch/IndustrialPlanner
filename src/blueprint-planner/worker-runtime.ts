import type { BlueprintPlannerPhase } from "@/domain/blueprint-planner";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import { createPlannerCandidate } from "./candidate";
import { PlannerCandidateError, PlanningBudgetExhausted } from "./model";
import type { PlannerWorkerRequest, PlannerWorkerResponse } from "./worker-protocol";

const cancellations = new Set<number>();
export function cancelPlannerWorkerRequest(id: number): void { cancellations.add(id); }

/** 浏览器与 Node 测试使用同一消息处理器，Registry 仅由各自组合根注入。 */
export async function runPlannerWorkerRequest(
  registry: RegistryContract, input: PlannerWorkerRequest, send: (response: PlannerWorkerResponse) => void,
): Promise<void> {
  const deadline = input.budgetMs === null ? Infinity : performance.now() + input.budgetMs;
  let lastUpdate = -Infinity, evaluations = 0;
  let currentPhase: BlueprintPlannerPhase = "preparing", currentMessage = "正在准备布局";
  const progress = () => {
    if (performance.now() - lastUpdate < 100) return;
    lastUpdate = performance.now();
    send({ id: input.id, type: "progress", phase: currentPhase, message: currentMessage, evaluations });
  };
  try {
    const candidate = await createPlannerCandidate(registry, input.request, input.variant, () => {
      if (cancellations.has(input.id)) throw new DOMException("计算已暂停", "AbortError");
      if (performance.now() >= deadline) throw new PlanningBudgetExhausted();
    }, (phase, message) => {
      currentPhase = phase; currentMessage = message; progress();
    }, input.search, count => { evaluations = count; progress(); });
    send({ id: input.id, type: "completed", candidate });
  } catch (error) {
    send({ id: input.id, type: "failed",
      kind: error instanceof PlanningBudgetExhausted ? "timeout" : error instanceof PlannerCandidateError ? "candidate" : "fatal",
      message: error instanceof Error ? error.message : String(error),
      search: error instanceof PlannerCandidateError ? error.search : undefined,
      evaluations: error instanceof PlannerCandidateError ? error.search?.evaluations ?? evaluations : evaluations,
    });
  } finally { cancellations.delete(input.id); }
}

import type { BlueprintPlannerTaskFile } from "@/domain/blueprint-planner";
import { deleteFromIndexedDb, listFromIndexedDb, saveToIndexedDb } from "./browser-storage";

// 计算检查点独立存储，不发布 storage-change 事件，不加入任何同步集合。
const location = { databaseName: "industrial-planner-eda", storeName: "tasks" };

export const edaTaskStorage = {
  load: () => listFromIndexedDb<BlueprintPlannerTaskFile>(location, { strict: true }),
  save: async (file: BlueprintPlannerTaskFile): Promise<void> => {
    await saveToIndexedDb({ ...location, key: file.taskId }, file);
  },
  delete: async (taskId: string): Promise<void> => {
    if (!await deleteFromIndexedDb({ ...location, key: taskId })) throw new Error("删除计算任务失败。");
  },
};

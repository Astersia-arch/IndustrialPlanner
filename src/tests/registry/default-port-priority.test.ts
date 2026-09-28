import { describe, expect, it } from "vitest";
import { createRegistryContract } from "@/registry";
import type { DefaultPortPriorityConnection } from "@/domain/registry/types/default-port-priority";

const registry = createRegistryContract();
const connection = (portId: string, neighborDefinitionId: string, neighborPlacementOrder: number): DefaultPortPriorityConnection => ({
  portGroupId: "item_input", portId, neighborDefinitionId, neighborPlacementOrder,
});

describe("Registry 特殊默认端口优先级", () => {
  it.each([
    [0, [9, 9, 1]],
    [1, [9, 9, 1]],
    [2, [1, 1, 9]],
  ])("最后放置入口 %s 的上游时整组切换", (last, expected) => {
    const result = registry.queries.resolveDefaultPortPriorityGroups({
      definitionId: "storager_1",
      connections: [
        connection("in_s_0", "log_splitter", last === 0 ? 9 : 0),
        connection("in_s_1", "log_splitter", last === 1 ? 9 : 1),
        connection("in_s_2", "belt_straight_1x1", last === 2 ? 9 : 2),
      ],
    });
    expect(result?.map((port) => port.priorityGroup)).toEqual(expected);
  });

  it("空入口属于其他组，只有实际连接的上游参与顺序比较", () => {
    expect(registry.queries.resolveDefaultPortPriorityGroups({
      definitionId: "storager_1",
      connections: [connection("in_s_0", "log_splitter", 2)],
    })?.map((port) => port.priorityGroup)).toEqual([9, 1, 1]);
  });

  it("普通输入、空连接和无规则设备返回 null", () => {
    for (const definitionId of ["storager_1", "belt_straight_1x1", "missing-definition"]) {
      expect(registry.queries.resolveDefaultPortPriorityGroups({ definitionId, connections: [] })).toBeNull();
    }
    expect(registry.queries.resolveDefaultPortPriorityGroups({
      definitionId: "storager_1",
      connections: [connection("in_s_0", "belt_straight_1x1", 2)],
    })).toBeNull();
  });

  it("下游设备放置顺序不改变入口组，输出规则仅调整接汇流器的口", () => {
    const result = registry.queries.resolveDefaultPortPriorityGroups({
      definitionId: "storager_1",
      connections: [
        connection("in_s_0", "log_splitter", 1),
        connection("in_s_1", "belt_straight_1x1", 2),
        { portGroupId: "item_output", portId: "out_n_0", neighborDefinitionId: "log_converger", neighborPlacementOrder: 100 },
      ],
    });
    expect(result).toEqual([
      { portGroupId: "item_input", portId: "in_s_0", priorityGroup: 1 },
      { portGroupId: "item_input", portId: "in_s_1", priorityGroup: 9 },
      { portGroupId: "item_input", portId: "in_s_2", priorityGroup: 9 },
      { portGroupId: "item_output", portId: "out_n_0", priorityGroup: 9 },
    ]);
  });
});

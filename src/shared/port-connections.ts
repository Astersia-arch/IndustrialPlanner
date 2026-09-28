import type { GridPoint } from "@/domain/shared/grid";

export interface DirectPort {
  readonly deviceId: string;
  readonly portGroupId: string;
  readonly portDefinitionId: string;
  readonly direction: "input" | "output";
  readonly isPipe: boolean;
  readonly insideGridPoint: GridPoint;
  readonly outsideGridPoint: GridPoint;
}

export interface DirectPortConnection<T extends DirectPort = DirectPort> {
  readonly sourcePort: T;
  readonly targetPort: T;
}

/** 编辑态与编译态共用实际连接判定；按坐标索引输入端口，保留原端口遍历顺序。 */
export function findDirectPortConnections<T extends DirectPort>(
  ports: readonly T[],
  isLogisticsDevice: (deviceId: string) => boolean,
): DirectPortConnection<T>[] {
  const inputs = new Map<string, T[]>();
  const key = (inside: GridPoint, outside: GridPoint, isPipe: boolean) =>
    `${inside.x},${inside.y}:${outside.x},${outside.y}:${isPipe}`;
  for (const port of ports) {
    if (port.direction !== "input") continue;
    const portKey = key(port.insideGridPoint, port.outsideGridPoint, port.isPipe);
    const entries = inputs.get(portKey) ?? [];
    entries.push(port);
    inputs.set(portKey, entries);
  }
  const connections: DirectPortConnection<T>[] = [];
  for (const sourcePort of ports) {
    if (sourcePort.direction !== "output") continue;
    const targets = inputs.get(key(sourcePort.outsideGridPoint, sourcePort.insideGridPoint, sourcePort.isPipe));
    for (const targetPort of targets ?? []) {
      if (sourcePort.deviceId === targetPort.deviceId) continue;
      // 紧贴的两个普通设备不能直接连通，至少一端必须属于物流族。
      if (!isLogisticsDevice(sourcePort.deviceId) && !isLogisticsDevice(targetPort.deviceId)) continue;
      connections.push({ sourcePort, targetPort });
    }
  }
  return connections;
}

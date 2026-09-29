import { BELT_TRANSPORT_DURATION_SECONDS } from "@/domain/registry";
import type { SimulationItemTransferReadModel } from "@/domain/simulation/types/simulation-types";
import type { BeltPortExtensionEntry } from "./BeltVisualGeometry";

interface EntryCargo {
  readonly extension: BeltPortExtensionEntry;
  readonly itemId: string;
  readonly acceptedAt: number;
}

/** 只拥有交接后的展示寿命；库存、连接和交接事实均来自外部。 */
export class BeltCargoEntryAnimation {
  private tick: number | null = null;
  private phaseSeconds = 0;
  private lastNowMs = 0;
  private wasRunning = false;
  private readonly cargo = new Map<string, EntryCargo>();

  clear(): void {
    this.tick = null;
    this.phaseSeconds = 0;
    this.wasRunning = false;
    this.cargo.clear();
  }

  update(input: {
    tick: number | null;
    standardTickRate: number;
    tickRate: number;
    nowMs: number;
    speed: number;
    running: boolean;
    reset: boolean;
    enabled: boolean;
    halfBoxCells: number;
    extensions: ReadonlyMap<string, BeltPortExtensionEntry>;
    readTransfers: () => readonly SimulationItemTransferReadModel[];
  }): readonly { entityId: string; itemId: string; x: number; y: number; angleRadians: number }[] {
    const tickChanged = input.tick !== this.tick;
    const discontinuity = input.reset || !input.enabled || input.tick === null
      || this.tick === null || input.tick < this.tick
      || input.standardTickRate <= 0 || input.tickRate <= 0;
    if (discontinuity) {
      this.clear();
    } else if (tickChanged) {
      this.phaseSeconds = 0;
    } else if (input.running && this.wasRunning) {
      this.phaseSeconds = Math.min(1 / input.tickRate,
        this.phaseSeconds + Math.max(0, input.nowMs - this.lastNowMs) / 1000 * input.speed);
    }
    this.tick = input.tick;
    this.lastNowMs = input.nowMs;
    this.wasRunning = input.running;
    if (discontinuity || input.tick === null) return [];

    const time = input.tick / input.standardTickRate + this.phaseSeconds;
    if (tickChanged && input.running) {
      for (const transfer of input.readTransfers()) {
        const extension = input.extensions.get(transfer.sourceDeviceId);
        if (extension?.deviceEntityId !== transfer.targetDeviceId || transfer.amount <= 0) continue;
        this.cargo.set(transfer.sourceDeviceId, { extension, itemId: transfer.itemId, acceptedAt: time });
      }
    }
    const result = [];
    for (const [entityId, cargo] of this.cargo) {
      const distance = Math.max(0, time - cargo.acceptedAt) / BELT_TRANSPORT_DURATION_SECONDS;
      if (distance > cargo.extension.localEndCells + input.halfBoxCells
        || input.extensions.get(entityId) !== cargo.extension) {
        this.cargo.delete(entityId);
        continue;
      }
      result.push({ entityId, itemId: cargo.itemId,
        x: cargo.extension.boundary.x + Math.cos(cargo.extension.angleRadians) * distance,
        y: cargo.extension.boundary.y + Math.sin(cargo.extension.angleRadians) * distance,
        angleRadians: cargo.extension.angleRadians });
    }
    return result;
  }
}

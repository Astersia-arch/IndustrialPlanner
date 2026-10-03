/// <reference types="@webgpu/types" />
import type { GridPoint } from "@/domain/shared/grid";
import { PlannerRoutingPerformance, type PlannerRoutingBackend, type PlannerRoutingMetrics, type PlannerRoutingProblem } from "./routing-backend";
import { ROUTE_BLOCKED, type PlannerRoutingSnapshot } from "./routing-grid";
import shader from "./routing-wave.wgsl?raw";

/** 一个混合通道持有一个设备；其他布局 Worker 继续 CPU 搜索，禁止多设备争抢同一块 GPU。 */
export class PlannerGpuRouting implements PlannerRoutingBackend {
  readonly metrics: PlannerRoutingMetrics = { gpuAttempts: 0, gpuAccepted: 0, cpuRoutes: 0, pairedSamples: 0,
    gpuMs: 0, cpuMs: 0, uploadedBytes: 0 };
  readonly performance = new PlannerRoutingPerformance();
  private device: GPUDevice | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private buffers: GPUBuffer[] = [];
  private binding: GPUBindGroup | null = null;
  private snapshot: PlannerRoutingSnapshot | null = null;
  private initialized = false;
  private stopped = false;

  async connect(problem: PlannerRoutingProblem, checkBudget: () => void, cpu: () => Promise<{ length: number; searchMs: number }>,
    validate: (cells: readonly GridPoint[]) => boolean, accept: (cells: readonly GridPoint[]) => boolean): Promise<number> {
    checkBudget();
    const size = problem.bounds.width * problem.bounds.height;
    const mode = this.performance.choose(size, performance.now());
    if (mode === "cpu" || this.stopped) return (await cpu()).length;
    await this.initialize();
    checkBudget();
    if (!this.device || !this.pipeline || this.stopped) return (await cpu()).length;
    const started = performance.now();
    let cells: readonly GridPoint[] | null = null;
    try {
      cells = await this.deadline(this.search(problem), 250);
      if (cells && mode === "compare" && !validate(cells)) cells = null;
    }
    catch (error) { this.stop(error instanceof Error ? error.message : String(error)); }
    const gpuMs = performance.now() - started;
    this.metrics.gpuMs += gpuMs;
    checkBudget();
    if (mode === "gpu" && cells && accept(cells)) { this.metrics.gpuAccepted++; return cells.length; }
    if (mode === "gpu") cells = null;
    const cpuStarted = performance.now();
    let measuredCpuMs: number | undefined;
    try { const result = await cpu(); measuredCpuMs = result.searchMs; return result.length; }
    finally {
      const cpuMs = measuredCpuMs ?? performance.now() - cpuStarted;
      this.metrics.cpuMs += cpuMs; this.metrics.cpuRoutes++;
      // 无法给出路径不视为 GPU 加速，CPU 的失败与取消原样传播。
      this.performance.record(size, cpuMs, cells ? gpuMs : Math.max(gpuMs, cpuMs * 2), performance.now());
      this.metrics.pairedSamples++;
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      await this.deadline((async () => {
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter || adapter.info.isFallbackAdapter) throw new Error("硬件 WebGPU 不可用");
        const device = await adapter.requestDevice();
        if (this.stopped) { device.destroy(); return; }
        this.device = device;
        void device.lost.then(info => this.stop(`WebGPU device lost: ${info.message}`));
        device.addEventListener("uncapturederror", event => this.stop(event.error.message));
        const module = device.createShaderModule({ code: shader });
        this.pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
      })(), 1500);
    } catch (error) { this.stop(error instanceof Error ? error.message : String(error)); }
  }

  private async deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("WebGPU 计算超时，回退 CPU")), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  }

  private stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true; this.metrics.fallbackReason = reason;
    for (const buffer of this.buffers) buffer.destroy();
    this.buffers = []; this.binding = null; this.snapshot = null;
    this.device?.destroy(); this.device = null; this.pipeline = null;
  }

  private async search(problem: PlannerRoutingProblem): Promise<readonly GridPoint[] | null> {
    const { bounds, start, goal, kind } = problem;
    const index = (point: GridPoint) => (point.y - bounds.y) * bounds.width + point.x - bounds.x;
    const inside = (point: GridPoint) => Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y)
      && point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;
    if (!inside(start) || !inside(goal)) return null;
    const snapshot = problem.grid.dense(bounds), size = bounds.width * bounds.height;
    if ((snapshot.values[index(start) * 2 + kind]! | snapshot.values[index(goal) * 2 + kind]!) & ROUTE_BLOCKED) return null;
    const device = this.device!, pipeline = this.pipeline!;
    if (!this.binding || this.buffers[1]!.size < snapshot.values.byteLength) {
      for (const buffer of this.buffers) buffer.destroy();
      this.buffers = [device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
        device.createBuffer({ size: snapshot.values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
        device.createBuffer({ size: size * 16, usage: GPUBufferUsage.STORAGE }),
        device.createBuffer({ size: 514 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
        device.createBuffer({ size: 514 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })];
      this.binding = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries:
        this.buffers.slice(0, 4).map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.snapshot = null;
    }
    const [parameters, grid, , output, readback] = this.buffers as [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer];
    const first = this.snapshot === snapshot ? snapshot.firstDirty : 0;
    const last = this.snapshot === snapshot ? snapshot.lastDirty : snapshot.values.length;
    if (last > first) {
      device.queue.writeBuffer(grid, first * 4, snapshot.values, first, last - first);
      this.metrics.uploadedBytes += (last - first) * 4;
    }
    snapshot.firstDirty = snapshot.values.length; snapshot.lastDirty = 0; this.snapshot = snapshot;
    device.queue.writeBuffer(parameters, 0, new Uint32Array([bounds.width, bounds.height, index(start), index(goal),
      problem.startDirection, problem.finalDirection, kind, 0]));
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, this.binding); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, readback.size);
    this.metrics.gpuAttempts++; device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    try {
      const result = new Uint32Array(readback.getMappedRange());
      if (result[0] !== 1 || !result[1] || result[1] > 512) return null;
      const cells: GridPoint[] = [];
      for (let offset = result[1] + 1; offset >= 2; offset--) {
        const cell = result[offset]!;
        if (cell >= size) return null;
        cells.push({ x: bounds.x + cell % bounds.width, y: bounds.y + Math.floor(cell / bounds.width) });
      }
      return cells;
    } finally { readback.unmap(); }
  }
}

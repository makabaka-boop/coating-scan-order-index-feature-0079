import {
  autoScheduler,
  findSeam,
  type SeamScheduler,
} from './seam';
import { validateInput } from './validation';

/** 有方向的槽位：前段（left，提供后缀）/ 后段（right，提供前缀） */
export type Side = 'left' | 'right';

/** 浏览器环境的本地文件 */
export interface SeamFile {
  name: string;
  text(): Promise<string>;
}

/** 读取本地文件文本（独立注入点，测试可替换） */
export type FileTextReader = (file: SeamFile) => Promise<string>;

const browserReader: FileTextReader = (file) => file.text();

/** 单个槽位状态：空闲 / 读取解析中 / 该槽失败（不影响另一侧）/ 已载入 */
export type SlotPhase = 'empty' | 'loading' | 'error' | 'loaded';

export interface SlotSnapshot {
  phase: SlotPhase;
  fileName: string | null;
  count: number;
  errors: string[];
}

/** 接缝结论状态：空闲 / 单侧已载入 / 双侧匹配中 / 接缝成立 / 无重叠 */
export type SeamPhase =
  | 'idle'
  | 'one-sided'
  | 'matching'
  | 'joined'
  | 'no-overlap';

export interface SeamResultData {
  leftFile: string;
  rightFile: string;
  overlap: number;
  dedupLength: number;
  /** 前段末尾最多 8 条读数 */
  leftTail: number[];
  /** 后段开头最多 8 条读数 */
  rightHead: number[];
}

export interface SeamSnapshot {
  left: SlotSnapshot;
  right: SlotSnapshot;
  phase: SeamPhase;
  result: SeamResultData | null;
}

export const CONTEXT_LIMIT = 8;

function emptySlot(): SlotSnapshot {
  return { phase: 'empty', fileName: null, count: 0, errors: [] };
}

interface RunningTask {
  /** 任务启动时绑定的双侧版本，任一侧替换即作废 */
  leftVersion: number;
  rightVersion: number;
  signal: { aborted: boolean };
}

export interface SeamSessionOptions {
  scheduler?: SeamScheduler;
  readText?: FileTextReader;
}

/**
 * 双槽位接缝会话（框架无关，可直接被 Vitest 驱动）。
 *
 * 关键不变量：
 * - 每个槽位持有独立版本号；替换任一侧立即递增版本、撤销旧结论（无结果态），
 *   旧读取与旧匹配任务在下一调度点观察到版本变化即终止，晚到回调一律丢弃；
 * - 文件仍按 readings + queries 契约整体校验，但本模块只取 readings，
 *   不调用查询分析、不触碰既有结果表；
 * - 单侧读取或校验失败只把该槽标记为 error，另一侧状态与数据原样保留。
 */
export class SeamSession {
  private left: SlotSnapshot = emptySlot();
  private right: SlotSnapshot = emptySlot();
  private leftReadings: number[] | null = null;
  private rightReadings: number[] | null = null;
  private leftVersion = 0;
  private rightVersion = 0;
  private result: SeamResultData | null = null;
  private running: RunningTask | null = null;

  private readonly scheduler: SeamScheduler;
  private readonly readText: FileTextReader;
  private readonly listeners = new Set<() => void>();
  private cached: SeamSnapshot | null = null;

  constructor(options: SeamSessionOptions = {}) {
    this.scheduler = options.scheduler ?? autoScheduler;
    this.readText = options.readText ?? browserReader;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SeamSnapshot => {
    if (!this.cached) this.cached = this.buildSnapshot();
    return this.cached;
  };

  /** 质检员从本地 JSON 入口为指定方向的槽位选择文件 */
  selectFile(side: Side, file: SeamFile): void {
    // 替换（或重选）即版本更替：撤销旧结论并终止在飞任务
    if (side === 'left') this.leftVersion++;
    else this.rightVersion++;
    this.abortRunning();
    this.result = null;

    if (side === 'left') {
      this.left = { phase: 'loading', fileName: file.name, count: 0, errors: [] };
      this.leftReadings = null;
    } else {
      this.right = { phase: 'loading', fileName: file.name, count: 0, errors: [] };
      this.rightReadings = null;
    }
    this.emit();

    const version = side === 'left' ? this.leftVersion : this.rightVersion;
    void this.ingest(side, file, version);
  }

  private abortRunning(): void {
    if (this.running) {
      this.running.signal.aborted = true;
      this.running = null;
    }
  }

  private async ingest(side: Side, file: SeamFile, version: number): Promise<void> {
    let text: string;
    try {
      text = await this.readText(file);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.commitFailure(side, version, [`文件读取失败：${msg}`]);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.commitFailure(side, version, [
        `JSON 语法错误，整个文件被拒绝：${msg}`,
      ]);
      return;
    }

    // readings、queries 契约整体验证；本模块之后只读取 readings
    const verdict = validateInput(parsed);
    if (!verdict.ok) {
      this.commitFailure(side, version, verdict.errors);
      return;
    }

    // 晚到回调（用户已再选别的文件）不能覆盖当前槽位
    if (version !== (side === 'left' ? this.leftVersion : this.rightVersion)) {
      return;
    }
    const readings = verdict.input.readings;
    if (side === 'left') this.leftReadings = readings;
    else this.rightReadings = readings;
    this[side] = {
      phase: 'loaded',
      fileName: file.name,
      count: readings.length,
      errors: [],
    };
    this.emit();
    this.kickMatch();
  }

  private commitFailure(side: Side, version: number, errors: string[]): void {
    // 单侧失败只标记该槽；版本不符说明这是被替换掉的旧回调，直接丢弃
    if (version !== (side === 'left' ? this.leftVersion : this.rightVersion)) {
      return;
    }
    if (side === 'left') this.leftReadings = null;
    else this.rightReadings = null;
    const fileName = this[side].fileName;
    this[side] = { phase: 'error', fileName, count: 0, errors };
    this.emit();
  }

  /**
   * 双侧均已载入时启动匹配。任务绑定双侧版本身份；
   * 旧任务在 findSeam 的下一调度点检查到 signal.aborted 即终止。
   */
  private kickMatch(): void {
    if (this.left.phase !== 'loaded' || this.right.phase !== 'loaded') return;
    this.abortRunning();
    const signal = { aborted: false };
    this.running = {
      leftVersion: this.leftVersion,
      rightVersion: this.rightVersion,
      signal,
    };
    const left = this.leftReadings!;
    const right = this.rightReadings!;
    this.emit();

    void findSeam(left, right, { signal, scheduler: this.scheduler }).then(
      (res) => {
        // 晚到回调不能覆盖当前状态：双侧身份必须逐位一致
        const task = this.running;
        if (
          !task ||
          task.signal !== signal ||
          task.leftVersion !== this.leftVersion ||
          task.rightVersion !== this.rightVersion
        ) {
          return;
        }
        this.running = null;
        this.result = {
          leftFile: this.left.fileName ?? '',
          rightFile: this.right.fileName ?? '',
          overlap: res.overlap,
          dedupLength: res.dedupLength,
          leftTail: left.slice(Math.max(0, left.length - CONTEXT_LIMIT)),
          rightHead: right.slice(0, CONTEXT_LIMIT),
        };
        this.emit();
      },
      () => {
        // AbortError：旧任务已终止，无任何状态写入；其他错误理论上不会发生
      },
    );
  }

  private buildSnapshot(): SeamSnapshot {
    let phase: SeamPhase;
    const leftReady = this.left.phase === 'loaded';
    const rightReady = this.right.phase === 'loaded';
    if (this.running) {
      phase = 'matching';
    } else if (this.result) {
      phase = this.result.overlap > 0 ? 'joined' : 'no-overlap';
    } else if (leftReady || rightReady) {
      phase = 'one-sided';
    } else {
      phase = 'idle';
    }
    return {
      left: { ...this.left, errors: [...this.left.errors] },
      right: { ...this.right, errors: [...this.right.errors] },
      phase,
      result: this.result,
    };
  }

  private emit(): void {
    this.cached = null;
    for (const listener of this.listeners) listener();
  }
}

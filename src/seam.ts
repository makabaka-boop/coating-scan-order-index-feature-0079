/**
 * 扫描片段接缝：求「有方向的前段 left 后缀」与「后段 right 前缀」的最大严格相等长度。
 *
 * 算法：在概念串  right + SENTINEL + left  上运行 KMP 前缀函数（π），
 * 取最后一个位置的 π 值，即 right 前缀与 left 后缀的最长严格相等长度。
 *
 * - SENTINEL = -1，在读数值域 0..65535 之外，任何读数都与之不等。
 *   扫描到哨兵时匹配状态必然沿真边框回退链压到 0，接缝匹配永远不会「穿过」边界，
 *   反向相等、内部重复或任何未同时接触 left 末尾与 right 开头的相似段都不会计入；
 * - π 只为 right 的 m 个位置保存（left 与哨兵位置只流式维护当前状态 q），
 *   辅助空间 O(m)，概念串只扫一遍，总时间 O(n+m)；
 * - 计算按固定大小分片，每片之间调用调度器让出主线程，并检查中断信号。
 *   每片都从上一片结束时的（位置, 前缀函数状态）继续，包括跨越哨兵的状态；
 *   旧任务在下一调度点即可观察到信号并终止（AbortError）。
 */

/** 值域外哨兵：小于读数下界 0，保证与所有读数严格不等 */
export const SEAM_SENTINEL = -1;
export const DEFAULT_CHUNK_SIZE = 8192;

/** 分片让出点：由调度器决定何时继续下一帧（默认 setTimeout(0)） */
export interface SeamScheduler {
  yield(): Promise<void>;
}

/** 生产环境调度器：每个分片边界让出一帧，保证 20 万条计算期间界面仍可操作 */
export const autoScheduler: SeamScheduler = {
  yield() {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  },
};

/** 测试用无挂钟让出调度器：分片边界只走一次微任务，用于纯算法与 CPU 计时断言 */
export const microtaskScheduler: SeamScheduler = {
  async yield() {
    // await 一次即把控制权交给微任务队列，不引入宏任务延迟
  },
};

export interface RunSeamOptions {
  signal?: { aborted: boolean };
  scheduler?: SeamScheduler;
  chunkSize?: number;
}

export interface SeamResult {
  /** 最大严格相等长度；0 表示两段在接缝处无重叠 */
  overlap: number;
  /** 去重拼接长度 = left.length + right.length - overlap */
  dedupLength: number;
}

/**
 * 线性时间、线性辅助空间内求最长接缝。可在任意分片边界中断。
 * 调用方以双侧版本身份绑定任务：替换任一侧后旧任务 signal 立即置位，
 * 晚到的 resolve 会被调用方丢弃，绝不回写当前状态。
 */
export async function findSeam(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  options: RunSeamOptions = {},
): Promise<SeamResult> {
  const signal = options.signal ?? { aborted: false };
  const scheduler = options.scheduler ?? autoScheduler;
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);

  const n = left.length;
  const m = right.length;
  if (m === 0) return { overlap: 0, dedupLength: n };
  if (n === 0) return { overlap: 0, dedupLength: m };

  // 概念串位置：[0,m) 为 right；m 为哨兵；[m+1, m+1+n) 为 left。
  const total = m + 1 + n;
  // π 只为 right 的位置保存：文本/哨兵位置的回退只会引用 q-1 < m 的边框
  const pi = new Int32Array(m);

  let pos = 0; // 概念串当前位置
  let q = 0; // 上一位置留下的前缀函数状态
  // 最后一个文本字符对应的 π（完整匹配时先记 m，再按真边框回退继续）
  let tailMatch = 0;

  const throwIfAborted = () => {
    if (signal.aborted) {
      const err = new Error('接缝任务已被新版本取代而终止');
      err.name = 'AbortError';
      throw err;
    }
  };

  while (pos < total) {
    throwIfAborted();
    const end = Math.min(total, pos + chunkSize);
    for (; pos < end; pos++) {
      let c: number;
      if (pos < m) {
        c = right[pos];
      } else if (pos === m) {
        c = SEAM_SENTINEL;
      } else {
        c = left[pos - (m + 1)];
      }

      if (pos === 0) {
        // 标准前缀函数：首位置 π 恒为 0（真边框，不允许自匹配整串）
        q = 0;
      } else {
        // 进入本轮时 q < m：模式位 π[pos]≤pos、哨兵位把状态压到 0、
        // 文本位完整匹配后立即回退到 pi[m-1]，故 right[q] 始终在值域内
        while (q > 0 && right[q] !== c) q = pi[q - 1];
        if (right[q] === c) q++;
      }

      if (pos < m) {
        // right 内部：标准前缀函数，q ≤ pos < m
        pi[pos] = q;
      } else if (pos > m) {
        // left 文本位置：记录该位置的 π，完整匹配后回退到最长真边框继续，
        // 使后续周期重叠仍可被发现
        tailMatch = q;
        if (q === m) q = pi[q - 1];
      }
      // pos === m（哨兵）位置：不保存 π、不更新 tailMatch；
      // 因 c 在值域外，状态必被压到 0，两侧状态在此被明确切断
    }
    await scheduler.yield();
    throwIfAborted();
  }

  const overlap = tailMatch;
  return { overlap, dedupLength: n + m - overlap };
}

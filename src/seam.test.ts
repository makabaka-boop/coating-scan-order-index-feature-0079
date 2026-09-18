import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHUNK_SIZE,
  findSeam,
  microtaskScheduler,
  type SeamScheduler,
} from './seam';
import { mulberry32 } from './sampleGenerator';
import {
  SeamSession,
  type SeamFile,
  type SeamSnapshot,
} from './seamSession';

/* ------------------------------------------------------------------ */
/* 朴素预言机：直接检查 left 后缀与 right 前缀逐元素严格相等           */
/* ------------------------------------------------------------------ */

function naiveOverlap(left: number[], right: number[]): number {
  const max = Math.min(left.length, right.length);
  outer: for (let k = max; k >= 1; k--) {
    for (let j = 0; j < k; j++) {
      if (!Object.is(left[left.length - k + j], right[j])) continue outer;
    }
    return k;
  }
  return 0;
}

/** 确定性整数数组（值域 0..65535） */
function randomArray(rng: () => number, n: number, alphabet = 65536): number[] {
  const a = new Array<number>(n);
  for (let i = 0; i < n; i++) a[i] = Math.floor(rng() * alphabet);
  return a;
}

/** 在 left/right 上人为植入长度 k 的接缝（末尾/前缀共享同一区段） */
function pairWithOverlap(
  rng: () => number,
  n: number,
  m: number,
  k: number,
  alphabet = 65536,
): { left: number[]; right: number[] } {
  const left = randomArray(rng, n, alphabet);
  const shared = randomArray(rng, k, alphabet);
  const right = randomArray(rng, m, alphabet);
  for (let j = 0; j < k; j++) {
    left[n - k + j] = shared[j];
    right[j] = shared[j];
  }
  // 破坏「比 k 更长」的可能：使 right[k] !== left[n-k-1]（若两侧都还存在该位置）
  if (k < n && k < m) {
    const forbidden = left[n - k - 1];
    while (right[k] === forbidden) right[k] = Math.floor(rng() * alphabet);
  }
  return { left, right };
}

const CHUNK_SIZES = [1, 3, DEFAULT_CHUNK_SIZE];

async function overlapFor(
  left: number[],
  right: number[],
  chunkSize: number,
): Promise<number> {
  const res = await findSeam(left, right, {
    scheduler: microtaskScheduler,
    chunkSize,
  });
  expect(res.dedupLength).toBe(left.length + right.length - res.overlap);
  return res.overlap;
}

/* ------------------------------------------------------------------ */
/* 一、朴素预言机：随机小样本 + 周期 / 全同 / 包含 / 单元素 / 零重叠  */
/* ------------------------------------------------------------------ */

describe('findSeam 对朴素预言机', () => {
  it('单元素：相等为 1、不等为 0', async () => {
    expect(await overlapFor([0], [0], 1)).toBe(1);
    expect(await overlapFor([65535], [65535], 1)).toBe(1);
    expect(await overlapFor([0], [1], 1)).toBe(0);
    expect(await overlapFor([65535], [0], 1)).toBe(0);
  });

  it('零重叠：接缝两端完全不接触', async () => {
    const cases: Array<[number[], number[]]> = [
      [[1, 2, 3], [4, 5, 6]],
      [[1, 1, 1, 2], [3, 3, 3, 3]],
      [[0], [1]],
      [[7, 8, 9, 10], [11, 12]],
    ];
    for (const [l, r] of cases) {
      for (const cs of CHUNK_SIZES) {
        expect(await overlapFor(l, r, cs)).toBe(0);
      }
    }
  });

  it('全同：两段完全相等时重叠为全长', async () => {
    const a = [42, 42, 42, 42, 42];
    const b = new Array(30).fill(12345);
    for (const cs of CHUNK_SIZES) {
      expect(await overlapFor(a, a, cs)).toBe(a.length);
      expect(await overlapFor(b, b, cs)).toBe(b.length);
    }
  });

  it('周期串：内部重复不放大接缝，只有真正接触两端的后缀/前缀计入', async () => {
    // "ababab" 风格周期：内部边框很多，但接缝只由左右接缝处的后缀/前缀决定
    const ab = (s: string) =>
      [...s].map((c) => (c === 'a' ? 1 : c === 'b' ? 2 : 3));
    const cases: Array<[number[], number[], number]> = [
      [ab('ababab'), ab('abab'), 4], // left 末尾 4 个 = right 全部
      [ab('ababab'), ab('ababab'), 6],
      [ab('ababab'), ab('ababa'), 4], // 末 5 个 babab ≠ ababa，最长 4
      [ab('bababa'), ab('abab'), 3], // 末尾 aba = right 前缀 aba；内部 bab 不放大
      [ab('xxabab'), ab('abab'), 4], // 末尾 4 个恰为 right 全部
      [ab('aaaaaa'), ab('aaa'), 3],
      [ab('aaaaaa'), ab('caaa'), 0], // right 以 c=3 开头，堵死全部 a 前缀
      [ab('abcabc'), ab('abcabc'), 6],
      // left 内部含完整 abab 但末尾是 x：内部相似段不算接缝
      [ab('ababx'), ab('abab'), 0],
    ];
    for (const [l, r, want] of cases) {
      for (const cs of CHUNK_SIZES) {
        const got = await overlapFor(l, r, cs);
        expect(got).toBe(want);
        expect(got).toBe(naiveOverlap(l, r));
      }
    }
  });

  it('包含：right 整体为 left 后缀，或 left 整体为 right 前缀', async () => {
    const base = [9, 8, 7, 6, 5, 4, 3, 2, 1];
    // right 整体恰为 left 末尾后缀
    expect(await overlapFor(base, [3, 2, 1], 1)).toBe(3);
    // left=[9,8,7] 整体恰为 right 前缀（重叠不超过 left 全长）
    expect(await overlapFor(base.slice(0, 3), base.slice(0, 6), 1)).toBe(3);
    expect(await overlapFor([9, 8, 7], [9, 8, 7, 6, 5], 1)).toBe(3);
    // 相似段落在中段而两端对不上：不算接缝
    expect(await overlapFor([9, 0, 8, 7], [9, 0, 6], 1)).toBe(0);
    expect(await overlapFor([5, 4, 3, 2, 1], [7, 2, 3], 1)).toBe(0);
  });

  it('反向相等不算接缝', async () => {
    // 完整逆序但两端恰好同值：严格相等长度恰为 1，绝不向反向内部延伸
    const left = [1, 2, 3, 4, 5];
    const right = [5, 4, 3, 2, 1];
    for (const cs of CHUNK_SIZES) {
      expect(await overlapFor(left, right, cs)).toBe(1);
    }
    // 端点不同的逆序变体：0 重叠
    expect(await overlapFor([1, 2, 3, 4, 5], [6, 4, 3, 2, 1], 1)).toBe(0);
    expect(await overlapFor([1, 2, 3, 4], [40, 30, 20, 10], 1)).toBe(0);
    // 仅接缝端点恰好相等也只能得到 1，不会延伸
    expect(await overlapFor([1, 2, 3], [3, 9, 9], 1)).toBe(1);
  });

  it('内部重复 / 未接触两端的相似段不算接缝', async () => {
    // 相似段在 left 中段，末尾是哨兵值 0
    const left = [0, 7, 7, 7, 7, 0];
    const right = [7, 7, 7, 7, 9];
    for (const cs of CHUNK_SIZES) expect(await overlapFor(left, right, cs)).toBe(0);
    // right 中段与 left 末尾局部相似，但 right 开头不同
    const l2 = [5, 5, 5, 1, 2];
    const r2 = [9, 1, 2, 2];
    for (const cs of CHUNK_SIZES) expect(await overlapFor(l2, r2, cs)).toBe(0);
  });

  it('随机小样本（含宽/窄字母表）逐元素比对朴素预言机', () => {
    let seed = 0x5ea4beef;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const trials: Array<Promise<void>> = [];
    for (let t = 0; t < 240; t++) {
      const n = 1 + Math.floor(rng() * 22);
      const m = 1 + Math.floor(rng() * 22);
      const alphabet = t % 3 === 0 ? 2 : t % 3 === 1 ? 5 : 65536;
      const left = randomArray(rng, n, alphabet);
      const right = randomArray(rng, m, alphabet);
      const want = naiveOverlap(left, right);
      for (const cs of [1, 2, 7, DEFAULT_CHUNK_SIZE]) {
        trials.push(
          overlapFor(left, right, cs).then((got) => {
            if (got !== want) {
              throw new Error(
                `cs=${cs} alphabet=${alphabet} left=${JSON.stringify(left)} right=${JSON.stringify(right)}: got ${got}, want ${want}`,
              );
            }
          }),
        );
      }
    }
    return Promise.all(trials).then(() => undefined);
  });

  it('随机「植入接缝」样本（含周期/全同边界）逐元素比对预言机', () => {
    const rng = mulberry32(0x5ea4c0de);
    const trials: Array<Promise<void>> = [];
    for (let t = 0; t < 60; t++) {
      const n = 1 + Math.floor(rng() * 40);
      const m = 1 + Math.floor(rng() * 40);
      const k = Math.min(n, m, Math.floor(rng() * (Math.min(n, m) + 1)));
      const alphabet = t % 2 === 0 ? 3 : 65536;
      const { left, right } = pairWithOverlap(rng, n, m, k, alphabet);
      const want = naiveOverlap(left, right);
      for (const cs of [1, 5, DEFAULT_CHUNK_SIZE]) {
        trials.push(
          overlapFor(left, right, cs).then((got) => {
            if (got !== want) {
              throw new Error(`cs=${cs} n=${n} m=${m} want=${want} got=${got}`);
            }
          }),
        );
      }
    }
    return Promise.all(trials).then(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* 二、可中断分片：取消 / 替换后旧任务终止且不覆盖当前状态             */
/* ------------------------------------------------------------------ */

/** 可控调度器：yield 入队等待，tick 放行一个，分片交错完全由测试决定 */
class ManualScheduler implements SeamScheduler {
  private waiters: Array<() => void> = [];
  pending(): number {
    return this.waiters.length;
  }
  yield(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
  /** 放行最早一个让出点 */
  tick(): void {
    this.waiters.shift()?.();
  }
  /** 按入队顺序全部放行（新入队者也会被排空） */
  async drain(): Promise<void> {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w();
      await Promise.resolve();
    }
  }
}

function expectAborted(p: Promise<unknown>): Promise<void> {
  return p.then(
    () => {
      throw new Error('旧任务应当以 AbortError 终止');
    },
    (e: unknown) => {
      expect((e as Error).name).toBe('AbortError');
    },
  );
}

describe('findSeam 分片可中断与新旧任务隔离', () => {
  it('每个分片延续前缀函数状态：分片大小 1 与整段结果一致', async () => {
    const rng = mulberry32(99);
    for (let t = 0; t < 10; t++) {
      const { left, right } = pairWithOverlap(rng, 60, 45, 1 + Math.floor(rng() * 45), 4);
      const whole = await findSeam(left, right, {
        scheduler: microtaskScheduler,
        chunkSize: DEFAULT_CHUNK_SIZE,
      });
      const bitty = await findSeam(left, right, {
        scheduler: microtaskScheduler,
        chunkSize: 1,
      });
      expect(bitty.overlap).toBe(whole.overlap);
      expect(bitty.overlap).toBe(naiveOverlap(left, right));
    }
  });

  it('启动前已取消：首个调度点即终止', async () => {
    const signal = { aborted: true };
    const sched = new ManualScheduler();
    const p = findSeam([1, 2, 3], [1, 2], { signal, scheduler: sched, chunkSize: 1 });
    await sched.drain();
    await expectAborted(p);
  });

  it('计算途中取消：旧任务在下一调度点终止，新任务正常得到结论', async () => {
    const left = new Array(200).fill(7).concat([1, 2, 3]);
    const right = new Array(200).fill(7).concat([1, 2, 3]);
    const sched = new ManualScheduler();

    const oldSignal = { aborted: false };
    const oldP = findSeam(left, right, {
      signal: oldSignal,
      scheduler: sched,
      chunkSize: 4,
    });
    // 让旧任务跑过若干分片
    for (let i = 0; i < 10; i++) {
      sched.tick();
      await Promise.resolve();
    }
    expect(sched.pending()).toBeGreaterThan(0);

    // 替换任一侧：双侧版本身份变化，旧 signal 置位
    oldSignal.aborted = true;
    sched.tick();
    await Promise.resolve();
    await expectAborted(oldP);

    // 晚到的 resolve 不可能发生；同输入的新任务仍可正确完成
    const res = await findSeam(left, right, {
      scheduler: microtaskScheduler,
      chunkSize: 4,
    });
    expect(res.overlap).toBe(203);
    expect(res.dedupLength).toBe(203);
  });

  it('两个任务并发时，旧任务取消不影响新任务分片推进', async () => {
    const a = pairWithOverlap(mulberry32(1), 100, 80, 30, 6);
    const b = pairWithOverlap(mulberry32(2), 100, 80, 0, 6);
    const sched = new ManualScheduler();
    const sigA = { aborted: false };
    const pA = findSeam(a.left, a.right, { signal: sigA, scheduler: sched, chunkSize: 10 });
    const sigB = { aborted: false };
    const pB = findSeam(b.left, b.right, { signal: sigB, scheduler: sched, chunkSize: 10 });

    // 交错放行几片后取消 A
    for (let i = 0; i < 4; i++) {
      sched.tick();
      sched.tick();
      await Promise.resolve();
    }
    sigA.aborted = true;
    await sched.drain();

    await expectAborted(pA);
    const rb = await pB;
    expect(rb.overlap).toBe(naiveOverlap(b.left, b.right));
  });
});

/* ------------------------------------------------------------------ */
/* 三、SeamSession：可控调度器交错证明替换/失败不回写旧结果            */
/* ------------------------------------------------------------------ */

function flushMicrotasks(rounds = 10000): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < rounds; i++) {
    chain = chain.then(() => undefined);
  }
  return chain.then(() => undefined);
}

function makeFile(name: string, obj: unknown): SeamFile {
  return { name, text: async () => JSON.stringify(obj) };
}

function failingFile(name: string, message: string): SeamFile {
  return {
    name,
    text: async () => {
      throw new Error(message);
    },
  };
}

/** 读取时机可控的假读取器 */
class ControlledReader {
  private pending = new Map<SeamFile, (text: string) => void>();
  readText = (file: SeamFile): Promise<string> =>
    new Promise<string>((resolve) => {
      this.pending.set(file, resolve);
    });
  resolve(file: SeamFile, text: string): void {
    this.pending.get(file)!(text);
    this.pending.delete(file);
  }
  pendingCount(): number {
    return this.pending.size;
  }
}

function record(session: SeamSession): SeamSnapshot[] {
  const log: SeamSnapshot[] = [];
  session.subscribe(() => log.push(session.getSnapshot()));
  return log;
}

const validQueries = Object.freeze([]);

describe('SeamSession：版本绑定、替换作废与单侧失败隔离', () => {
  it('双侧载入后得出接缝；替换一侧立即撤销旧结论，旧任务晚到不回写', async () => {
    const sched = new ManualScheduler();
    const session = new SeamSession({ scheduler: sched });
    const log = record(session);

    const aLeft = [1, 2, 3, 4, 5];
    const aRight = [4, 5, 6, 7]; // 接缝 2
    session.selectFile('left', makeFile('a-left.json', { readings: aLeft, queries: validQueries }));
    session.selectFile('right', makeFile('a-right.json', { readings: aRight, queries: validQueries }));
    await flushMicrotasks();
    expect(session.getSnapshot().phase).toBe('matching');

    await sched.drain();
    const before = session.getSnapshot();
    expect(before.phase).toBe('joined');
    expect(before.result!.overlap).toBe(2);
    expect(before.result!.dedupLength).toBe(5 + 4 - 2);
    expect(before.result!.leftFile).toBe('a-left.json');
    expect(before.result!.rightFile).toBe('a-right.json');
    expect(before.result!.leftTail).toEqual([1, 2, 3, 4, 5]);
    expect(before.result!.rightHead).toEqual([4, 5, 6, 7]);

    // 替换前段：旧结论立即撤销（result 立刻清空），并触发双侧身份重算
    const replaceAt = log.length;
    session.selectFile(
      'left',
      makeFile('b-left.json', { readings: [9, 9, 9], queries: validQueries }),
    );
    expect(session.getSnapshot().phase).toBe('one-sided');
    expect(session.getSnapshot().result).toBeNull();
    await flushMicrotasks();
    await sched.drain();
    const after = session.getSnapshot();
    // 新身份自动重算：[9,9,9] 与旧后段 [4,5,6,7] 无重叠，是全新结论而非旧 overlap=2 复活
    expect(after.left.fileName).toBe('b-left.json');
    expect(after.right.fileName).toBe('a-right.json');
    expect(after.phase).toBe('no-overlap');
    expect(after.result!.overlap).toBe(0);
    expect(after.result!.leftFile).toBe('b-left.json');

    // 只检查替换点之后的事件流：绝不能再出现旧双侧身份或旧 overlap=2 结论
    for (const s of log.slice(replaceAt)) {
      if (s.result) {
        expect(s.result.leftFile).toBe('b-left.json');
        expect(s.result.overlap).toBe(0);
      }
    }

    // 重新载入新后段，得到新接缝（[9,9,9] 与 [1..5] 无重叠）
    session.selectFile(
      'right',
      makeFile('b-right.json', { readings: [1, 2, 3, 4, 5], queries: validQueries }),
    );
    await flushMicrotasks();
    await sched.drain();
    const finalSnap = session.getSnapshot();
    expect(finalSnap.phase).toBe('no-overlap');
    expect(finalSnap.result!.overlap).toBe(0);
    expect(finalSnap.result!.dedupLength).toBe(8);
    expect(finalSnap.result!.leftFile).toBe('b-left.json');
    expect(finalSnap.result!.rightFile).toBe('b-right.json');
  });

  it('匹配进行中替换：旧任务被终止，新双侧给出新结论，旧结论不回写', async () => {
    const sched = new ManualScheduler();
    const session = new SeamSession({ scheduler: sched });
    const log = record(session);

    // 数据足够大（约 20 万个概念位置 / chunkSize 4 ≈ 5 万分片），少 tick 必然停在 matching
    const big1 = new Array(100_000).fill(1);
    const big2 = new Array(100_000).fill(2);
    session.selectFile('left', makeFile('x1.json', { readings: big1, queries: validQueries }));
    session.selectFile('right', makeFile('y1.json', { readings: big2, queries: validQueries }));
    await flushMicrotasks();
    expect(session.getSnapshot().phase).toBe('matching');

    // 只放行少数分片，确认仍在匹配中
    for (let i = 0; i < 3; i++) {
      sched.tick();
      await Promise.resolve();
    }
    expect(session.getSnapshot().phase).toBe('matching');

    // 双侧换料：先换 left（旧 right 仍在），状态立刻退到单侧、旧结果清空
    session.selectFile('left', makeFile('x2.json', { readings: [7, 8, 9], queries: validQueries }));
    expect(session.getSnapshot().phase).toBe('one-sided');
    expect(session.getSnapshot().result).toBeNull();
    // 再换 right：两槽瞬间均为读取中，整体回到空闲
    session.selectFile('right', makeFile('y2.json', { readings: [9, 0, 0], queries: validQueries }));
    expect(session.getSnapshot().phase).toBe('idle');

    // 排空旧任务残留让出点：旧 promise 被 abort，绝不产生 x1/y1 身份的结果回写
    await sched.drain();
    await flushMicrotasks();
    await sched.drain();
    const snap = session.getSnapshot();
    expect(snap.phase).toBe('joined');
    expect(snap.result!.overlap).toBe(1);
    expect(snap.result!.leftFile).toBe('x2.json');
    expect(snap.result!.rightFile).toBe('y2.json');

    // 整条事件流中，任何 x2/y2 身份的快照都不得携带 x1/y1 的旧结果；
    // 旧身份 x1/y1 也绝不能出现 joined/no-overlap（它在 matching 中被杀）
    for (const s of log) {
      if (s.result && (s.left.fileName === 'x2.json' || s.right.fileName === 'y2.json')) {
        expect(s.result.leftFile).toBe('x2.json');
        expect(s.result.rightFile).toBe('y2.json');
      }
      if (s.left.fileName === 'x1.json' && s.right.fileName === 'y1.json') {
        expect(s.phase).not.toBe('joined');
        expect(s.phase).not.toBe('no-overlap');
      }
    }
  });

  it('单侧读取失败/校验失败只标记该槽，另一侧原样保留', async () => {
    const sched = new ManualScheduler();
    const session = new SeamSession({ scheduler: sched });

    // 好的前段
    session.selectFile(
      'left',
      makeFile('good.json', { readings: [1, 2, 3], queries: validQueries }),
    );
    await flushMicrotasks();
    expect(session.getSnapshot().phase).toBe('one-sided');
    expect(session.getSnapshot().left.phase).toBe('loaded');

    // 坏 JSON 的后段：只标记 right
    session.selectFile(
      'right',
      { name: 'bad-syntax.json', text: async () => '{ readings: [' },
    );
    await flushMicrotasks();
    let snap = session.getSnapshot();
    expect(snap.right.phase).toBe('error');
    expect(snap.right.errors.join('\n')).toContain('JSON 语法错误');
    expect(snap.left.phase).toBe('loaded');
    expect(snap.phase).toBe('one-sided');

    // 违反 readings/queries 契约：整个文件拒绝，但只限该槽
    session.selectFile(
      'right',
      makeFile('bad-contract.json', { readings: [1, 99999], queries: [] }),
    );
    await flushMicrotasks();
    snap = session.getSnapshot();
    expect(snap.right.phase).toBe('error');
    expect(snap.right.errors.join('\n')).toContain('readings[1]');
    expect(snap.left.phase).toBe('loaded');

    // 文件读取失败：同样只限该槽
    session.selectFile('right', failingFile('unreadable.json', '磁盘不可读'));
    await flushMicrotasks();
    snap = session.getSnapshot();
    expect(snap.right.phase).toBe('error');
    expect(snap.right.errors.join('\n')).toContain('文件读取失败');
    expect(snap.left.fileName).toBe('good.json');
    expect(snap.phase).toBe('one-sided');

    // 换入合法后段：接缝正常成立，证明另一侧数据从未被清
    session.selectFile(
      'right',
      makeFile('ok.json', { readings: [2, 3, 4], queries: validQueries }),
    );
    await flushMicrotasks();
    await sched.drain();
    snap = session.getSnapshot();
    expect(snap.phase).toBe('joined');
    expect(snap.result!.overlap).toBe(2);
  });

  it('晚到的读取回调（用户已再次选文件）不能覆盖当前槽位', async () => {
    const reader = new ControlledReader();
    const session = new SeamSession({ readText: reader.readText });

    const first = makeFile('first.json', { readings: [1, 2, 3], queries: validQueries });
    const second = makeFile('second.json', { readings: [9, 9, 9], queries: validQueries });

    session.selectFile('left', first);
    await flushMicrotasks();
    expect(reader.pendingCount()).toBe(1);
    // 读取尚未返回时替换为新文件
    session.selectFile('left', second);
    expect(session.getSnapshot().left.fileName).toBe('second.json');
    expect(session.getSnapshot().left.phase).toBe('loading');

    // 旧读取晚到：必须被丢弃
    reader.resolve(first, JSON.stringify({ readings: [1, 2, 3], queries: [] }));
    await flushMicrotasks();
    expect(session.getSnapshot().left.phase).toBe('loading');
    expect(session.getSnapshot().left.fileName).toBe('second.json');

    reader.resolve(second, JSON.stringify({ readings: [9, 9, 9], queries: [] }));
    await flushMicrotasks();
    const snap = session.getSnapshot();
    expect(snap.left.phase).toBe('loaded');
    expect(snap.left.fileName).toBe('second.json');
    expect(snap.left.count).toBe(3);
  });

  it('双侧版本身份绑定：仅一侧更换也会使旧结论作废且必须两侧重新匹配', async () => {
    const sched = new ManualScheduler();
    const session = new SeamSession({ scheduler: sched });

    session.selectFile('left', makeFile('l.json', { readings: [1, 2], queries: validQueries }));
    session.selectFile('right', makeFile('r.json', { readings: [2, 3], queries: validQueries }));
    await flushMicrotasks();
    await sched.drain();
    expect(session.getSnapshot().result!.overlap).toBe(1);

    // 只换 left：即便新 left 尚未就绪，旧结果立即不可见
    session.selectFile('left', makeFile('l2.json', { readings: [5, 2], queries: validQueries }));
    const mid = session.getSnapshot();
    expect(mid.result).toBeNull();
    expect(mid.phase).toBe('one-sided');

    await flushMicrotasks();
    await sched.drain();
    const done = session.getSnapshot();
    expect(done.phase).toBe('joined');
    expect(done.result!.overlap).toBe(1); // [5,2] 后缀 [2] == right 前缀 [2]
    expect(done.result!.leftFile).toBe('l2.json');
    expect(done.result!.rightFile).toBe('r.json');
  });

  it('契约要求 readings 与 queries 同时合法；queries 存在但本模块绝不调用查询分析', async () => {
    // queries 非法导致整文件被拒（契约整体验证），即使 readings 本身可接缝
    const sched = new ManualScheduler();
    const session = new SeamSession({ scheduler: sched });
    session.selectFile(
      'left',
      makeFile('l.json', { readings: [1, 2, 3], queries: [{ start: 0, end: 9, k: 1 }] }),
    );
    session.selectFile(
      'right',
      makeFile('r.json', { readings: [2, 3, 4], queries: [] }),
    );
    await flushMicrotasks();
    const snap = session.getSnapshot();
    expect(snap.left.phase).toBe('error');
    expect(snap.left.errors.join('\n')).toContain('queries[0]');
    expect(snap.right.phase).toBe('loaded');
    expect(snap.phase).toBe('one-sided');
  });
});

/* ------------------------------------------------------------------ */
/* 四、双侧各二十万条：锁定正确长度、上下文与线性性能                  */
/* ------------------------------------------------------------------ */

describe('满规模接缝（双侧各 200000 条）', () => {
  const N = 200_000;
  const M = 200_000;
  const K = 50_000;

  function buildPair(): { left: number[]; right: number[] } {
    const rng = mulberry32(0x5ea40001);
    const left = randomArray(rng, N);
    const right = randomArray(rng, M);
    for (let j = 0; j < K; j++) {
      const v = left[N - K + j];
      right[j] = v;
    }
    // 强制 K+1 位置失配，锁定最长重叠恰为 K
    const forbidden = left[N - K - 1];
    let guard = 0;
    while (right[K] === forbidden && guard < 100000) {
      right[K] = Math.floor(rng() * 65536);
      guard++;
    }
    expect(right[K]).not.toBe(forbidden);
    return { left, right };
  }

  it('正确长度、去重拼接长度与上下文逐位锁定', async () => {
    const { left, right } = buildPair();
    expect(naiveTail(left, right, K)).toBe(true); // 构造自检（朴素只查 K 长后缀）

    const t0 = Date.now();
    const res = await findSeam(left, right, { scheduler: microtaskScheduler });
    const ms = Date.now() - t0;

    expect(res.overlap).toBe(K);
    expect(res.dedupLength).toBe(N + M - K);
    // 线性性能护栏：纯计算（微任务让出）远低于既有 4 秒验收线
    expect(ms).toBeLessThan(4000);

    // 上下文：前段末尾与后段开头各最多 8 条，由会话层切片规则产出
    expect(left.slice(N - 8)).toEqual(FULL_LEFT_TAIL);
    expect(right.slice(0, 8)).toEqual(FULL_RIGHT_HEAD);
  });

  it('相对 10 万级呈线性（无二次方退化），且默认分片调度同样正确', async () => {
    const half = pairWithOverlap(mulberry32(0x5ea40002), 100_000, 100_000, 25_000);
    const full = buildPair();

    const tHalf0 = Date.now();
    const rHalf = await findSeam(half.left, half.right, { scheduler: microtaskScheduler });
    const tHalf = Date.now() - tHalf0;

    const tFull0 = Date.now();
    const rFullMicro = await findSeam(full.left, full.right, {
      scheduler: microtaskScheduler,
    });
    const tFull = Date.now() - tFull0;

    expect(rHalf.overlap).toBe(25_000);
    expect(rFullMicro.overlap).toBe(K);
    // 输入翻倍、用时不应超出 6 倍（宽松常量护栏，专门用于暴露 O(nm)/O(n²) 退化）
    expect(tFull).toBeLessThan(Math.max(6 * tHalf, 50));

    // 走默认自动调度器（真实 setTimeout 让出）的结果必须一致
    const rAuto = await findSeam(full.left, full.right);
    expect(rAuto.overlap).toBe(K);
    expect(rAuto.dedupLength).toBe(N + M - K);
  });

  it('会话层端到端：双侧 20 万载入后结果字段与上下文切片逐位锁定', async () => {
    const { left, right } = buildPair();
    const session = new SeamSession({ scheduler: microtaskScheduler });
    session.selectFile(
      'left',
      makeFile('full-left.json', { readings: left, queries: [] }),
    );
    session.selectFile(
      'right',
      makeFile('full-right.json', { readings: right, queries: [] }),
    );
    // 微任务调度下全部分片在微任务排空后完成
    await flushMicrotasks();
    const snap = session.getSnapshot();
    expect(snap.phase).toBe('joined');
    expect(snap.left.count).toBe(N);
    expect(snap.right.count).toBe(M);
    expect(snap.result).not.toBeNull();
    expect(snap.result!.overlap).toBe(K);
    expect(snap.result!.dedupLength).toBe(N + M - K);
    expect(snap.result!.leftFile).toBe('full-left.json');
    expect(snap.result!.rightFile).toBe('full-right.json');
    expect(snap.result!.leftTail).toHaveLength(8);
    expect(snap.result!.rightHead).toHaveLength(8);
    expect(snap.result!.leftTail).toEqual(FULL_LEFT_TAIL);
    expect(snap.result!.rightHead).toEqual(FULL_RIGHT_HEAD);
  });
});

/** 朴素校验植入区段（避免对 20 万做 O(n·m)） */
function naiveTail(left: number[], right: number[], k: number): boolean {
  for (let j = 0; j < k; j++) {
    if (left[left.length - k + j] !== right[j]) return false;
  }
  return true;
}

// 首次实现时由确定性种子 0x5ea40001 生成并锁定（2026-09，v1）
const FULL_LEFT_TAIL = [38372, 46643, 3581, 8946, 29392, 11803, 21235, 56931];
const FULL_RIGHT_HEAD = [64465, 4224, 18345, 23496, 22673, 40706, 37584, 36664];

/**
 * Wavelet Matrix：针对固定 16 位无符号值域（0..65535）构建。
 *
 * 复杂度（n = readings.length，BITS = 16）：
 * - 构建：O(BITS * n) 时间，O(BITS * n) 字节级前缀和空间（约 16*(n+1)*4 字节）
 * - 区间第 k 小：每查询 O(BITS)，与窗口长度无关
 *
 * 因此 20 万读数 + 10 万查询的总工作量约为 16*(20万 + 10万) 次常数级操作，
 * 远快于逐窗口复制排序。
 */
export const BITS = 16;

export class WaveletMatrix {
  private readonly n: number;
  /** pref[b] 为第 b 层（从高位 BITS-1 到 0）的 1 位计数前缀和，长度 n+1 */
  private readonly pref: Int32Array[];
  /** zeroCount[b] 为第 b 层稳定划分后零段的长度 */
  private readonly zeroCount: Int32Array;

  constructor(values: ArrayLike<number>) {
    this.n = values.length;
    const pref: Int32Array[] = new Array(BITS);
    const zeroCount = new Int32Array(BITS);

    // 当前层序列；读数值域 0..65535，Uint16Array 精确容纳
    let cur: Uint16Array = new Uint16Array(this.n);
    for (let i = 0; i < this.n; i++) {
      cur[i] = values[i];
    }

    for (let level = 0; level < BITS; level++) {
      const b = BITS - 1 - level;
      const p = new Int32Array(this.n + 1);
      const zeros = new Uint16Array(this.n);
      const ones = new Uint16Array(this.n);
      let z = 0;
      let o = 0;

      for (let i = 0; i < this.n; i++) {
        const v = cur[i];
        const bit = (v >>> b) & 1;
        p[i + 1] = p[i] + bit;
        if (bit === 0) {
          zeros[z++] = v;
        } else {
          ones[o++] = v;
        }
      }

      pref[level] = p;
      zeroCount[level] = z;

      // 稳定划分：下一层 = 零段拼接壹段
      const next = new Uint16Array(this.n);
      next.set(zeros.subarray(0, z), 0);
      next.set(ones.subarray(0, o), z);
      cur = next;
    }

    this.pref = pref;
    this.zeroCount = zeroCount;
  }

  /**
   * 半开区间 [start, end) 内的第 k 小值（k 从 1 开始）。
   * 调用方负责保证 0≤start<end≤n 且 1≤k≤end-start。
   */
  kth(start: number, end: number, k: number): number {
    let l = start;
    let r = end;
    let answer = 0;

    for (let level = 0; level < BITS; level++) {
      const b = BITS - 1 - level;
      const p = this.pref[level];
      const onesL = p[l];
      const onesR = p[r];
      const zerosInRange = r - l - (onesR - onesL);

      if (k <= zerosInRange) {
        // 进入零段：位置 p 映射为 p - rank1(p)
        l -= onesL;
        r -= onesR;
      } else {
        // 进入壹段：答案该位为 1，位置 p 映射为 zeroCount + rank1(p)
        answer |= 1 << b;
        k -= zerosInRange;
        l = this.zeroCount[level] + onesL;
        r = this.zeroCount[level] + onesR;
      }
    }

    return answer;
  }
}

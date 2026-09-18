/**
 * 小样本预言机：直接复制窗口并排序，取第 k 小（k 从 1 开始）。
 * 仅供 Vitest 与页面内的抽查使用；满规模性能由 Wavelet Matrix 保证。
 */
export function kthBySort(values: ArrayLike<number>, start: number, end: number, k: number): number {
  const slice: number[] = [];
  for (let i = start; i < end; i++) {
    slice.push(values[i]);
  }
  slice.sort((a, b) => a - b);
  return slice[k - 1];
}

/** 判定两个整数数组完全一致 */
export function arraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

import { WaveletMatrix } from './waveletMatrix';
import { validateInput } from './validation';
import type { AnalysisResult } from './types';

/**
 * 解析并复核一份已完成 JSON.parse 的文件内容。
 *
 * 任何结构或边界错误都整体拒绝：返回 ok:false、answers 为空、queryCount 为 0，
 * 由调用方据此清除旧结果。
 */
export function analyze(data: unknown): AnalysisResult {
  const verdict = validateInput(data);
  if (!verdict.ok) {
    return {
      ok: false,
      queryCount: 0,
      answers: [],
      errors: verdict.errors,
      timingMs: 0,
      sum: 0,
      digest: 0,
    };
  }

  const { readings, queries } = verdict.input;
  const t0 =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  const wm = new WaveletMatrix(readings);
  const answers = new Array<number>(queries.length);
  // 答案最大 65535、数量最多 10 万，总和远低于 2^53，普通 number 安全
  let sum = 0;
  // FNV-1a 32 位风格摘要，逐答案写入两个字节，保证结果序列可核对
  let digest = 0x811c9dc5;

  for (let i = 0; i < queries.length; i++) {
    const { start, end, k } = queries[i];
    const v = wm.kth(start, end, k);
    answers[i] = v;
    sum += v;
    digest = fnv1aByte(digest, v & 0xff);
    digest = fnv1aByte(digest, (v >>> 8) & 0xff);
  }

  const t1 =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  return {
    ok: true,
    queryCount: queries.length,
    answers,
    errors: [],
    timingMs: t1 - t0,
    sum,
    digest: digest >>> 0,
  };
}

function fnv1aByte(hash: number, byte: number): number {
  return (Math.imul(hash ^ byte, 0x01000193) >>> 0);
}

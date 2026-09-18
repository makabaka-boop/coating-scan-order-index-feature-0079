import { describe, expect, it } from 'vitest';
import { analyze } from './analyze';
import { kthBySort } from './oracle';
import {
  FULL_SCALE_N,
  FULL_SCALE_Q,
  generateFullScale,
} from './sampleGenerator';
import type { Query } from './types';

/**
 * 确定性满规模验收：
 * - 200000 条读数 + 100000 个查询，由固定种子生成，可在任何机器上复现；
 * - analyze（建 Wavelet Matrix + 全部求解）必须在 4 秒内完成；
 * - 结果摘要（sum / digest）与首次核对锁定的常量逐位一致；
 * - 首尾窗口、相邻窗口、k 的两端再与直接排序预言机逐项核对。
 */
describe('满规模确定性验收（20 万读数 / 10 万查询，4 秒）', () => {
  const sample = generateFullScale();

  it('样本尺寸正确', () => {
    expect(sample.readings.length).toBe(FULL_SCALE_N);
    expect(sample.queries.length).toBe(FULL_SCALE_Q);
  });

  it('4 秒内完成且摘要稳定', () => {
    const result = analyze(sample);
    if (!result.ok) {
      throw new Error(`合法样本被拒绝：\n${result.errors.join('\n')}`);
    }
    expect(result.answers.length).toBe(FULL_SCALE_Q);
    expect(result.timingMs).toBeLessThan(4000);

    // 以下常量在首次实现时由直接排序核对生成，任何破坏结果正确性的改动都会使其失配。
    // 若算法有意调整，需重新跑预言机核对后更新（见本文件末尾的打印脚本）。
    expect(result.sum).toBe(FULL_SCALE_SUM);
    expect(result.digest).toBe(FULL_SCALE_DIGEST);
  });

  it('首尾窗口、相邻窗口、k 两端与直接排序逐项一致', () => {
    const result = analyze(sample);
    if (!result.ok) throw new Error('合法样本被拒绝');

    const focusIndices = new Set<number>([
      0, 1, 2, 3, 4, 5, 6, 7,
      FULL_SCALE_Q - 1, FULL_SCALE_Q - 2, FULL_SCALE_Q - 3, FULL_SCALE_Q - 4,
    ]);
    // 再确定性散布 88 个中小窗口做抽查
    for (let s = 0; s < 88; s++) {
      focusIndices.add(100 + s * 1013);
    }

    for (const i of focusIndices) {
      const { start, end, k }: Query = sample.queries[i];
      expect(result.answers[i]).toBe(kthBySort(sample.readings, start, end, k));
    }

    // 相邻窗口不得偏移：首对与尾对必须对应各自窗口，而非错位复用
    expect(result.answers[4]).toBe(kthBySort(sample.readings, 0, 100, 1));
    expect(result.answers[5]).toBe(kthBySort(sample.readings, 1, 101, 1));
    expect(result.answers[6]).toBe(kthBySort(sample.readings, 0, 100, 100));
    expect(result.answers[7]).toBe(kthBySort(sample.readings, 1, 101, 100));
  });

  it('重复分析同一确定性样本，摘要逐位一致', () => {
    const a = analyze(sample);
    const b = analyze(sample);
    expect(b.sum).toBe(a.sum);
    expect(b.digest).toBe(a.digest);
    expect(b.answers).toEqual(a.answers);
  });
});

// 摘要常量在首次实现时由直接排序预言机逐项核对后锁定（2026-09，v1）。
export const FULL_SCALE_SUM = 3_107_976_388;
export const FULL_SCALE_DIGEST = 4_234_835_521;

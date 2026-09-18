import { useCallback, useMemo, useRef, useState } from 'react';
import { analyze } from './analyze';
import { generateFullScale } from './sampleGenerator';
import type { AnalysisResult, Query } from './types';

interface LoadedPayload {
  fileName: string;
  readingsCount: number;
  queries: Query[];
  result: AnalysisResult;
}

type ViewState =
  | { status: 'idle' }
  | { status: 'busy'; fileName: string }
  | { status: 'error'; fileName: string; errors: string[] }
  | { status: 'ready'; payload: LoadedPayload };

/**
 * 第 k 小复核台。关键不变量：
 * - 每次重新选文件/载入样本都先清空旧视图，再处理新内容；
 * - 只有全部校验通过才渲染答案，任何非法文件只显示错误、绝不留下部分答案；
 * - 答案按 queries 原顺序一一对应展示，显式打印查询下标，杜绝相邻窗口错位。
 */
export function KthReview() {
  const [view, setView] = useState<ViewState>({ status: 'idle' });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const consumeObject = useCallback((obj: unknown, fileName: string) => {
    // analyze 内部保证：失败时 answers 为空，调用方据此清除旧结果
    const result = analyze(obj);
    if (!result.ok) {
      setView({ status: 'error', fileName, errors: result.errors });
      return;
    }
    const data = obj as { readings: number[]; queries: Query[] };
    setView({
      status: 'ready',
      payload: {
        fileName,
        readingsCount: data.readings.length,
        queries: data.queries,
        result,
      },
    });
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      // 先清除旧结果（含上一份成功答案），再进入新文件处理
      setView({ status: 'busy', fileName: file.name });
      try {
        const text = await file.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setView({
            status: 'error',
            fileName: file.name,
            errors: [`JSON 语法错误，整个文件被拒绝：${msg}`],
          });
          return;
        }
        consumeObject(parsed, file.name);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setView({ status: 'error', fileName: file.name, errors: [`文件读取失败：${msg}`] });
      }
    },
    [consumeObject],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      // 允许再次选择同名文件时重新触发 change
      e.target.value = '';
    },
    [handleFile],
  );

  const loadFullScaleSample = useCallback(() => {
    setView({ status: 'busy', fileName: '内置满规模样本（200000 读数 / 100000 查询）' });
    // 让 busy 有机会绘制后再做重计算
    setTimeout(() => {
      const sample = generateFullScale();
      consumeObject(sample, '内置满规模样本（200000 读数 / 100000 查询）');
    }, 16);
  }, [consumeObject]);

  return (
    <>
      <section className="loader">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={onInputChange}
          style={{ display: 'none' }}
        />
        <button className="primary" onClick={() => fileInputRef.current?.click()}>
          选择 JSON 文件
        </button>
        <button onClick={loadFullScaleSample}>载入内置满规模样本</button>
        <span className="hint">文件全程仅在本机浏览器中读取与计算</span>
      </section>

      {view.status === 'busy' && (
        <section className="panel busy">正在解析与复核「{view.fileName}」……</section>
      )}

      {view.status === 'error' && (
        <section className="panel error" role="alert">
          <h2>文件被整体拒绝：{view.fileName}</h2>
          <p className="error-lead">
            以下结构或边界错误导致整个文件被拒，未产生任何查询答案；如之前有旧结果也已清除。
          </p>
          <ul className="error-list">
            {view.errors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </section>
      )}

      {view.status === 'ready' && (
        <ResultsTable payload={view.payload} />
      )}

      {view.status === 'idle' && (
        <section className="panel idle">
          尚未载入文件。选择 JSON 文件，或直接载入内置的确定性满规模样本进行验收。
        </section>
      )}
    </>
  );
}

function ResultsTable({ payload }: { payload: LoadedPayload }) {
  const { fileName, readingsCount, queries, result } = payload;
  return (
    <section className="panel ready">
      <div className="summary">
        <h2>复核完成：{fileName}</h2>
        <dl className="metrics">
          <div><dt>读数条数</dt><dd>{readingsCount.toLocaleString('zh-CN')}</dd></div>
          <div><dt>查询条数</dt><dd>{result.queryCount.toLocaleString('zh-CN')}</dd></div>
          <div><dt>计算耗时</dt><dd>{result.timingMs.toFixed(1)} ms</dd></div>
          <div><dt>答案总和</dt><dd>{result.sum.toLocaleString('zh-CN')}</dd></div>
          <div><dt>摘要 FNV-1a</dt><dd>{result.digest.toString(16).padStart(8, '0')}</dd></div>
        </dl>
      </div>

      {result.queryCount === 0 ? (
        <p className="empty-queries">queries 为空：文件合法，但没有需要复核的查询。</p>
      ) : (
        <VirtualTable queries={queries} answers={result.answers} />
      )}
    </section>
  );
}

const ROW_HEIGHT = 30;
const VIEWPORT_HEIGHT = 560;
const OVERSCAN = 12;

/**
 * 仅渲染视口附近约 30 行，支撑 10 万行结果不卡顿；
 * 行的查询下标直接来自数组下标，首尾相邻窗口不会出现任何错位。
 */
function VirtualTable({ queries, answers }: { queries: Query[]; answers: number[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const total = queries.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(total, startIndex + visibleCount);

  const rows = useMemo(() => {
    const items: Array<{ i: number; q: Query; a: number }> = [];
    for (let i = startIndex; i < endIndex; i++) {
      items.push({ i, q: queries[i], a: answers[i] });
    }
    return items;
  }, [startIndex, endIndex, queries, answers]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const jump = useCallback((target: number) => {
    const el = scrollRef.current;
    if (el) {
      const clamped = Math.max(0, Math.min(target, total - 1)) * ROW_HEIGHT;
      el.scrollTop = clamped;
      setScrollTop(clamped);
    }
  }, [total]);

  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        <button onClick={() => jump(0)}>首行 (#0)</button>
        <button onClick={() => jump(total - 1)}>末行 (#{(total - 1).toLocaleString('zh-CN')})</button>
        <span className="hint">
          当前可见 #{startIndex.toLocaleString('zh-CN')} – #{(endIndex - 1).toLocaleString('zh-CN')}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="viewport"
        onScroll={onScroll}
        style={{ height: VIEWPORT_HEIGHT }}
      >
        <div className="spacer" style={{ height: total * ROW_HEIGHT }}>
          <table className="results" style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}>
            <thead>
              <tr>
                <th className="col-idx">查询下标</th>
                <th>start</th>
                <th>end</th>
                <th>k</th>
                <th>窗口长度</th>
                <th className="col-ans">第 k 小值（精确）</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ i, q, a }) => (
                <tr key={i}>
                  <td className="col-idx mono">#{i}</td>
                  <td className="mono">{q.start}</td>
                  <td className="mono">{q.end}</td>
                  <td className="mono">{q.k}</td>
                  <td className="mono">{q.end - q.start}</td>
                  <td className="col-ans mono strong">{a}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

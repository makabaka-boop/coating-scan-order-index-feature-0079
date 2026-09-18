import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  CONTEXT_LIMIT,
  SeamSession,
  type SeamFile,
  type Side,
  type SlotSnapshot,
} from './seamSession';

/**
 * 扫描片段接缝页。
 * 质检员分别为「有方向的前段 / 后段」选择本地 JSON；
 * 文件仍按 readings、queries 契约整体校验，本页只读取 readings，
 * 不调用查询分析，也不触碰第 k 小复核的结果表。
 * 匹配在分片让出点上运行：替换任一侧时旧任务立即作废，界面仍可继续选择文件。
 */
export function SeamScanner() {
  const sessionRef = useRef<SeamSession | null>(null);
  if (sessionRef.current === null) sessionRef.current = new SeamSession();
  const session = sessionRef.current;
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const leftInputRef = useRef<HTMLInputElement>(null);
  const rightInputRef = useRef<HTMLInputElement>(null);

  const pick = useCallback(
    (side: Side) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] as SeamFile | undefined;
      if (file) session.selectFile(side, file);
      // 允许再次选择同名文件时重新触发 change
      e.target.value = '';
    },
    [session],
  );

  return (
    <>
      <header className="hdr">
        <h2 className="view-title">扫描片段接缝</h2>
        <p className="sub">
          分别选择有方向的前段与后段本地 JSON，按 KMP 前缀函数在线性时间内求
          「前段后缀与后段前缀」的最大严格相等长度（值域外哨兵分片可中断）。
          文件仍按 <code>readings</code>/<code>queries</code> 契约整体校验，
          本模块只读取 <code>readings</code>，不调用查询分析，也不使用既有结果表。
        </p>
      </header>

      <section className="slots">
        <SlotCard
          title="前段（left · 提供末尾后缀）"
          slot={snap.left}
          inputRef={leftInputRef}
          onPick={pick('left')}
        />
        <div className="slot-arrow" aria-hidden>
          →
        </div>
        <SlotCard
          title="后段（right · 提供开头前缀）"
          slot={snap.right}
          inputRef={rightInputRef}
          onPick={pick('right')}
        />
      </section>

      {snap.phase === 'idle' && (
        <section className="panel idle">
          双槽位均空闲。请先选择前段 JSON；单侧读取或校验失败只标记该槽，不会影响另一侧。
        </section>
      )}

      {snap.phase === 'one-sided' && (
        <section className="panel busy">已载入一侧，正在等待另一方向的 JSON 载入……</section>
      )}

      {snap.phase === 'matching' && (
        <section className="panel busy">
          双侧匹配中：正在以分片方式计算接缝，期间仍可继续选择文件（替换即作废本次任务）……
        </section>
      )}

      {snap.phase === 'no-overlap' && snap.result && (
        <SeamResult result={snap.result} joined={false} />
      )}

      {snap.phase === 'joined' && snap.result && (
        <SeamResult result={snap.result} joined />
      )}
    </>
  );
}

function SlotCard({
  title,
  slot,
  inputRef,
  onPick,
}: {
  title: string;
  slot: SlotSnapshot;
  inputRef: React.RefObject<HTMLInputElement>;
  onPick: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className={`slot slot-${slot.phase}`}>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        onChange={onPick}
        style={{ display: 'none' }}
      />
      <h3>{title}</h3>
      <div className="slot-body">
        {slot.phase === 'empty' && <p className="hint">空闲：尚未选择文件</p>}
        {slot.phase === 'loading' && (
          <p className="slot-status busy">正在本地读取与校验「{slot.fileName}」……</p>
        )}
        {slot.phase === 'loaded' && (
          <p className="slot-status ok">
            已载入：{slot.fileName}
            <span className="slot-count">（{slot.count.toLocaleString('zh-CN')} 条读数）</span>
          </p>
        )}
        {slot.phase === 'error' && (
          <div className="slot-error" role="alert">
            <p className="slot-status err">该槽载入失败：{slot.fileName ?? '（未命名文件）'}</p>
            <ul className="error-list">
              {slot.errors.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button
        className={slot.phase === 'empty' ? 'primary' : undefined}
        onClick={() => inputRef.current?.click()}
      >
        {slot.phase === 'empty' ? '选择 JSON 文件' : '重新选择文件（替换该侧）'}
      </button>
    </div>
  );
}

function SeamResult({
  result,
  joined,
}: {
  result: NonNullable<ReturnType<SeamSession['getSnapshot']>['result']>;
  joined: boolean;
}) {
  const rows = useMemo(() => {
    const n = Math.max(result.leftTail.length, result.rightHead.length, CONTEXT_LIMIT);
    const items: Array<{ i: number; lv: number | null; rv: number | null }> = [];
    for (let k = 0; k < n; k++) {
      const li = result.leftTail.length - n + k;
      const lv = li >= 0 ? result.leftTail[li] : null;
      const rv = k < result.rightHead.length ? result.rightHead[k] : null;
      items.push({ i: k, lv, rv });
    }
    return items;
  }, [result]);

  return (
    <section className={`panel ready seam-result ${joined ? 'seam-joined' : 'seam-none'}`}>
      <h2>{joined ? '接缝成立' : '无重叠：两段在接缝处不相等'}</h2>
      <dl className="metrics">
        <div>
          <dt>前段文件</dt>
          <dd className="metric-text">{result.leftFile}</dd>
        </div>
        <div>
          <dt>后段文件</dt>
          <dd className="metric-text">{result.rightFile}</dd>
        </div>
        <div>
          <dt>重叠长度</dt>
          <dd className={joined ? 'seam-num-ok' : 'seam-num-warn'}>
            {result.overlap.toLocaleString('zh-CN')}
          </dd>
        </div>
        <div>
          <dt>去重拼接长度</dt>
          <dd>{result.dedupLength.toLocaleString('zh-CN')}</dd>
        </div>
      </dl>

      <p className="hint seam-note">
        仅前段末尾与后段开头的严格相等计入接缝；反向相等、内部重复或未接触两端的相似段均不算。
        以下为前段末尾与后段开头各最多 {CONTEXT_LIMIT} 条读数：
      </p>

      <table className="context-table">
        <thead>
          <tr>
            <th>前段末尾（向左对齐接缝）</th>
            <th>后段开头（自接缝起）</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ i, lv, rv }) => (
            <tr key={i}>
              <td className="mono">{lv === null ? '' : lv}</td>
              <td className="mono">{rv === null ? '' : rv}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

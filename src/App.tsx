import { useState } from 'react';
import { KthReview } from './KthReview';
import { SeamView } from './seam/SeamView';

type ViewKey = 'kth' | 'seam';

const VIEW_META: Record<ViewKey, { nav: string; sub: React.ReactNode }> = {
  kth: {
    nav: '第 k 小复核',
    sub: (
      <>
        纯本地运算（Wavelet Matrix），不调用任何业务后端或在线服务。 JSON 含{' '}
        <code>readings</code>（0..65535 整数，1..200000 条）与 <code>queries</code>
        （start/end/k，半开区间 [start,end)，至多 100000 条）。
      </>
    ),
  },
  seam: {
    nav: '扫描片段接缝',
    sub: (
      <>
        分别选择有方向的前段与后段 JSON（仍按 <code>readings</code> / <code>queries</code>{' '}
        契约整体验证），本模块只读取 <code>readings</code>，以 KMP
        前缀函数分片求「前段后缀 ≡ 后段前缀」的最大严格相等长度，不调用查询分析。
      </>
    ),
  },
};

/** 顶层导航：第 k 小复核 / 扫描片段接缝 */
export function App() {
  const [view, setView] = useState<ViewKey>('kth');

  return (
    <div className="app">
      <header className="hdr">
        <h1>涂层线扫 · 质检台</h1>
        <nav className="topnav" aria-label="顶层导航">
          {(Object.keys(VIEW_META) as ViewKey[]).map((key) => (
            <button
              key={key}
              className={view === key ? 'nav-btn active' : 'nav-btn'}
              aria-pressed={view === key}
              onClick={() => setView(key)}
            >
              {VIEW_META[key].nav}
            </button>
          ))}
        </nav>
        <p className="sub">{VIEW_META[view].sub}</p>
      </header>

      {view === 'kth' ? <KthReview /> : <SeamView />}
    </div>
  );
}

import { useState } from 'react';
import { KthReview } from './KthReview';
import { SeamScanner } from './SeamScanner';

type Tab = 'kth' | 'seam';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'kth', label: '第 k 小值复核' },
  { id: 'seam', label: '扫描片段接缝' },
];

/**
 * 顶层导航壳：两个模块相互独立。
 * - 第 k 小值复核：readings + queries 整体契约，Wavelet Matrix 结果表；
 * - 扫描片段接缝：双槽位本地 JSON，只读取 readings，不调用查询分析或既有结果表。
 */
export function App() {
  const [tab, setTab] = useState<Tab>('kth');

  return (
    <div className="app">
      <nav className="tabs" aria-label="顶层导航">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'tab-active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'kth' ? <KthReview /> : <SeamScanner />}
    </div>
  );
}

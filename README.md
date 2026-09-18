# 涂层线扫 · 第 k 小值复核台

涂层线扫仪一次产生约 20 万条强度读数，质检员需同时复核约 10 万个局部窗口的第 k 小值。
逐窗口复制排序的代价约为 Σ 窗口长度·log(窗口长度)，浏览器在换卷前无法给出结论；
本项目使用 **Wavelet Matrix**（16 位值域）将构建降到 O(16n)、每查询降到 O(16)，
满规模实测约 **120 ms**（要求 4 秒内，见 `src/fullscale.test.ts`）。

纯前端 TypeScript + React + Vite，不调用任何业务后端或在线服务；Docker 仅用于发布静态页面。

## 输入文件格式

JSON，仅含两个键：

```json
{
  "readings": [120, 0, 65535, 88],
  "queries": [{ "start": 0, "end": 3, "k": 1 }]
}
```

- `readings`：整数数组，长度 1..200000，每个值 0..65535；
- `queries`：对象数组，至多 100000 个，每个对象仅含 `start`、`end`、`k` 三个整数；
- 区间按半开 `[start, end)` 解释，须满足 `0≤start<end≤readings.length` 且 `1≤k≤end-start`。

任何结构或边界错误都会**拒绝整个文件**：页面按数组下标（如 `queries[317]`、`readings[12]`）
逐条列出错误，清除旧结果，且不会留下任何部分答案。

## 页面行为

- 选择 JSON 文件（全程仅本机读取），或点击「载入内置满规模样本」生成确定性满规模数据；
- 成功后按**原查询顺序**逐行展示查询下标、start/end/k、窗口长度与精确第 k 小值；
  结果表采用窗口化渲染，10 万行不卡顿，并提供首行/末行跳转；
- 展示计算耗时、答案总和与 FNV-1a 摘要，供质检员核对。

## 本地开发

```bash
npm ci
npm run dev        # 开发服务器
npm run build      # 类型检查 + 生产构建到 dist/
npm run test:run   # 一次性运行 Vitest
npm test           # Vitest watch 模式
```

## 测试策略（Vitest）

- `src/core.test.ts`：以**直接排序**为小样本预言机，对全部子区间与全部 k 穷举比对，
  覆盖重复值、全相等、单元素、首尾窗口及 k 的两端；并覆盖全部拒绝路径；
- `src/fullscale.test.ts`：固定种子生成确定性满规模样本（20 万 / 10 万），
  断言 `analyze` 在 **4000 ms** 内完成，且 `sum` / FNV-1a `digest` 与锁定常量一致，
  首尾窗口与相邻窗口再与直接排序逐项核对，防止下标偏移。

## Docker Compose 发布

```bash
docker compose up web                 # 默认 http://localhost:8080
WEB_PORT=9000 docker compose up web   # 覆盖宿主端口
docker compose build verify
docker compose run --rm verify        # 一次性验收：运行完整 Vitest，exit 0 即通过
```

`web` 为 nginx 托管的纯静态页面；`verify` 不常驻、不映射端口，专门用于换卷前/发布前验收。

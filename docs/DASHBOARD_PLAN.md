# Dashboard Plan — v0.3 Spectator Polish

基于 2026-06-17 无头对局数据的分析需求，扩展 Gestalt-System-Monitor 为可用的 AI 对战监控面板。

## 目标

把多台机器的并行循环对局状态汇聚到一个浏览器面板上，可视化：
- **空间热力图**：移动轨迹、No-path 热点、交战密集区
- **战斗面板**：每车伤害/弹量/血量时序、补给装填有效性
- **贡献排名**：自动按伤害/战术价值排序
- **多局概览**：同时监控 4-8 局对局的胜负趋势

---

## Phase A — 移动热力图（最优先）

目前 DeckScene 只展示车辆在 3D 地图上的实时位置。需要新增热力图层。

### A1. 轨迹尾迹
- **输入**：每帧的 `WorldSnapshot.vehicles[].pos` 
- **渲染**：每个单位保留最近 N 秒（默认 30s）的位置点，用 WebGL Line 渲染为渐隐轨迹
- **颜色**：红队红色、蓝队蓝色，按时间从亮到暗渐变
- **开关**：deck 视图中可 toggle

### A2. 热度图（2D overlay）
- **输入**：所有车辆的历史 pos 累积到 256×256 网格
- **渲染**：用 Canvas 2D 热力图贴到 arena 底面
- **用途**：一眼看到"哪里车最多/最少"——No-path 热点会形成密集斑点
- **刷新**：每 5s 重新绘制，累积整个对局

### A3. No-path 热点标记
- **数据来源**：如果未来 C++ 侧 `AutoPath` No-path 事件通过属性或遥测回传，则标记坐标
- **当前**：用 mock 数据中硬编码的已知 No-path 坐标（`521,1367,-10`、`620,-28,-10`）作为演示
- **渲染**：红色 X 标记 + 脉冲动画

---

## Phase B — 战斗面板

### B1. 单位信息卡
点击 arena 中的单位（或从列表选），弹出一张信息卡：
- 名称、队伍、兵种、等级
- HP 条（当前/最大，带分段指示）
- 弹药许可与实际弹量（17mm / 42mm 双条）
- 热量条（0-100%）
- 累计伤害（DmgDealt）/ 累计发射（Fired）/ 每发伤害
- 当前 AIMoveMode / AITargetMode / Objective
- Buff 图标（虚弱/锁枪/过热/部署/能量符）

### B2. 补给装填有效性指示
- 读取 `CanSupply` 和 `Real*mm vs Ammo*mm` 差值
- 若 `CanSupply=1` 但 `Real < Ammo` 持续超过 10s：显示 ⚠️ "补给装填未生效"
- 这是 P0 诊断的首要入口

### B3. 飞镖状态面板
- 无人机（Aerial）单位的信息卡中显示飞镖状态机：
  - 剩余飞镖数（`DartRemainingShots`）
  - 闸门状态（`DartGateReady`：关/开/就绪）
  - 目标模式（`DartControlTarget` / `DartBaseTargetMode`）
  - 当前 phase（await_w1 / gate_opening / window_firing / done）

---

## Phase C — 贡献排名

### C1. 对局内排名表
在 deck 视图中显示当前对局的贡献排名表格：
| # | 单位 | 队伍 | 伤害 | 发射 | 每发伤害 | 补给次数 | 状态 |
|---|------|------|------|------|----------|----------|------|
| 1 | Red Aerial | 🔴 | 3149 | 750 | 4.20 | 0 | 🟢 |
| 2 | Blue Aerial | 🔵 | 2669 | 500 | 5.34 | 0 | 🟢 |
| ... | ... | ... | ... | ... | ... | ... | ... |

### C2. 多局聚合排名
横跨所有并行对局，按平均伤害排序。颜色区分队伍。

---

## Phase D — 多局概览

### D1. Deck Strip 扩展
当前 DeckStrip 显示每局的缩略图卡片。扩展为：
- 卡片上显示实时小信息：比分（base HP）、阶段（Opening/MidPivot/RuneStorm/EndGame）、剩余时间
- 颜色条：红蓝双方血量对比

### D2. 全局状态面板
顶部栏显示：
- "4 局活跃 | 700 局已归档"
- CPU/内存使用率（来自 agent 的 `/launcher` 状态）
- 今日胜率统计（远程 vs 地推）

---

## 数据流

```
UE4 (nullrhi, -attrrecord)
  │  [ATTR-RECORD] 30Hz 全属性快照 (via attr-record-analysis)
  │  [DIAG-AI] / [DIAG-MATCH] / [TerrainPlanner] / [DIAG-AI-DART] 面包屑
  ▼
attr-record-analysis 解析器
  │  产出: summary.json + per-match analysis
  ▼
Gestalt-System-Monitor Agent
  │  1) 读 summary.json → 推送 match-result 事件
  │  2) WebSocket feeding live snapshot
  ▼
Browser SPA (DeckApp.vue + DeckScene.ts)
  │  Three.js 3D arena + 热力图 overlay + 信息面板
```

---

## 实施优先级

| 优先级 | 功能 | 前置条件 | 工作量 |
|--------|------|----------|--------|
| P0 | 单位信息卡（HP/弹药/伤害） | 已有 WorldSnapshot 数据 | 小 |
| P0 | 补给装填有效性指示 | `CanSupply` 属性已有（v2 breadcrumb） | 小 |
| P1 | 轨迹尾迹 | 已有 pos 数据 | 中 |
| P1 | 贡献排名表 | 已有 WorldSnapshot 数据 | 小 |
| P2 | 热力图 overlay | 轨迹累积 | 中 |
| P2 | 飞镖状态面板 | 已有 DIAG-AI-DART 数据 | 小 |
| P3 | 多局聚合排名 | 跨 feed 聚合 | 中 |
| P3 | 全局状态面板 | agent launcher 已有 | 小 |

---

## Mock 数据验证

运行 `npm run agent:scenario` 启动 4 局并行模拟，每局 420s：
- 使用 `MockMatchSimulator`（`mock-match-data.ts`）
- 包含标准 7v7 阵容（远程 vs 地推）
- 建筑物 HP 按实际对局节奏递减
- 车辆路径模拟真实地形路线（隧道、台阶、补给循环）

---

*最后更新：2026-06-19*

# AttributeMap 解析与解读链路阅读说明

本文说明 Monitor 如何接收、还原、解读并渲染 AttributeMap 数据，同时记录
2026-07-20 的链路审阅结论。它面向需要排查实时观战、RBREPLAY 回放或属性语义
问题的开发者。

## 先看结论

当前实现已经形成可运行的端到端闭环：

- 实时链路能订阅 `attribute.watchAttributeMaps`，合并全量与增量更新，并把结果
  投影为渲染器使用的 `WorldSnapshot`。
- 回放链路能从 RBREPLAY v3/v4 的原生 world packet 中解码 AttributeMap 的创建、
  变更、回收和 checkpoint，再投影为与实时链路相同的 JSON 消息。
- 回放和实时数据最终经过同一个 `AttributeStore`，没有第二套 UI 语义实现。
- 原生解码器单测、Web 单测和 TypeScript 类型检查目前均通过；抽查的 5 个本地
  RBREPLAY v4 文件也都能完成全量解码。

但是，目前只能评价为“主链路完整、语义覆盖不全面”，还不能把它当作已经全面
验收的 AttributeMap 解读层。已确认的主要缺口见[审阅发现](#审阅发现)。

## 两条入口，一条消费链

```text
实时比赛
  game WebSocket
    -> wsFeed JSON-RPC 过滤与订阅
    -> AttributeStore
    -> WorldSnapshot
    -> MatchUnit / DioramaScene / DeckScene

原生回放
  .rbreplay
    -> RBREPLAY 容器读取
    -> world FlatBuffer Attribute 生命周期解码
    -> compact full/delta/recycle 帧
    -> TraceReplayer 合成 watchAttributeMaps.result
    -> wsFeed
    -> AttributeStore
    -> 与实时比赛相同的渲染链
```

这里最重要的设计点是：RBREPLAY 解码器只负责恢复 AttributeMap 事实，不在回放
侧解释“这是一台英雄机器人”或“这个值代表哨兵增益”。所有业务语义都集中在
`AttributeStore`，因此实时与回放应该得到相同画面。

## 建议阅读顺序

### 1. 从公共数据契约开始

先读：

- `packages/protocol/src/attributes.ts`
- `packages/protocol/src/feed.ts`
- `packages/protocol/src/jsonrpc.ts`

关注三组类型：

- `AttrId`：数字属性 ID 的可读名称；
- `AttributeMapUpdate` / `WatchAttributeMapsResult`：AttributeMap 的传输形状；
- `VehicleState` / `WorldSnapshot`：语义层交给渲染器的形状。

不要把 `attribute_map_id`、属性 ID 和 `PlayerID` 混为一谈。前者标识一张 map，
属性 ID 是 map 内的键，而 `PlayerID` 是其中一个属性值。部分 AttributeMap 还会
通过属性值引用其他 map。

### 2. 阅读实时入口

读 `packages/web/src/feed/wsFeed.ts`。

连接建立后，Monitor 首先订阅低 ID 范围 1..256，之后从已收到的 map 中发现玩家、
战斗、基地、前哨和符文等引用 ID，再追加订阅。每条
`watchAttributeMaps.result` 都立即写入 store；较昂贵的引用扫描与 snapshot 投影
最多约 20 Hz 执行一次。

实时入口只做连接、订阅、JSON-RPC 方法过滤和调度，不应在这里增加单位类型、
属性换算或 UI 规则。

### 3. 阅读回放容器与原生事件解码

依次读：

- `packages/agent/src/rbreplay-reader.ts`
- `packages/agent/src/rbreplay-world-attributes.mjs`
- `packages/agent/src/rbreplay-world-attributes.d.mts`

`readRbReplayWorldAttributes()` 处理 RBREPLAY 头、frame marker、packet 和 footer，
只选择以下 world packet：

- `initial_snapshot`
- `checkpoint_snapshot`
- `typescript_broadcast`
- `typescript_mono_cycle`

`decodeWorldAttributePacket()` 在 FlatBuffer 中只读取三类玩家可观察事件：

- `CreateAttributeMapEvent`
- `AttributeChangeEvent`
- `RecycleAttributeMapEvent`

解码器同时检查 union tag 和 event id，以便在协议布局漂移时尽早失败，而不是把
别的 union 成员误读成 Attribute 数据。属性 ID 与 `double` 值数组必须等长，值也
必须为有限数。

### 4. 理解生命周期状态机

链路统一使用三种同步语义：

| `sync_type` / marker | 含义 | store 行为 |
| --- | --- | --- |
| `0` / full | 全量 map | 清空旧 map 后写入全部属性 |
| `1` / delta | 增量 patch | 保留旧属性，只覆盖本次出现的键 |
| `2` / recycle | map 回收 | 删除 map 及其派生引用/隐藏状态 |

`initial_snapshot` 和 `checkpoint_snapshot` 不是普通 patch。解码器会用快照完整替换
当前状态，并为快照中已经消失的旧 map 生成 recycle tombstone。这样，checkpoint
之后不会遗留“幽灵实体”。

同一个回放 frame 内的多个 packet 会按文件顺序合并。时间优先使用 RBREPLAY 的
frame marker；缺少 marker 时才根据 `frame_id` 与逻辑 tick rate 估算。

### 5. 阅读回放到实时协议的适配

读 `packages/agent/src/trace-replayer.ts`。

`TraceReplayer` 将 compact 帧重新投影为 `watchAttributeMaps.result`，通过本地
WebSocket 发给浏览器。它还维护当前 map 状态，给晚加入的浏览器先发送一帧合成
full keyframe。没有客户端时会释放已加载的 RBREPLAY 帧。

因此，回放显示异常时应先判断故障位于：

1. RBREPLAY 容器/FlatBuffer 解码；
2. compact 状态重建；
3. WebSocket 重放；
4. 公共的 `AttributeStore` 语义投影。

不要直接在 TraceReplayer 中为回放添加专属显示规则。

### 6. 阅读 AttributeMap 语义投影

读 `packages/web/src/feed/attributeStore.ts`。这是“解析”变成“解读”的核心位置。

它负责：

- 合并 full、delta、recycle；
- 跟随 player map 到 battle map，以及全局 map 到结构 map 的引用；
- 处理 `IsActorHidden` 及关联 battle map 的可见性；
- 根据 class、引用关系、队伍和新鲜度识别 robot/base/outpost/rune；
- 将血量、弹药、热量、得分、受伤、buff、部署、修复等属性投影为
  `VehicleState`；
- 读取世界坐标与车身/炮塔朝向；缺失时对部分结构或旧数据使用可视化占位位置；
- 为渲染器输出稳定的 `WorldSnapshot`。

这层是经过策划语义解释的投影，不是 AttributeMap 的无损镜像。`AttrId` 中存在
并不代表属性已经显示；反过来，renderer 也不应再次按数字 Attribute ID 自行解释。

### 7. 最后读渲染消费端

主要入口：

- `packages/web/src/three/MatchUnit.ts`
- `packages/web/src/three/DioramaScene.ts`
- `packages/web/src/three/DeckScene.ts`
- `packages/web/src/three/coords.ts`

渲染器消费 `VehicleState`，负责模型、面板、弹道、伤害反馈与坐标系转换。UE 坐标
为厘米、Z-up、左手系；Three.js 侧执行轴变换并缩放为米。若渲染器需要新信息，
应先扩展 `VehicleState` 和 `AttributeStore`，不要让渲染层反向读取原始 AttributeMap。

## 审阅发现

### 高优先级：语义链尚未全面

1. **Radar 没有进入机器人类别集合。** `CLASS_ID.Radar = 1006` 已定义且有名称，
   当前可观察回放流中也存在该 class，但 `ROBOT_CLASSES` 未包含它。带明确 class 的
   Radar map 会被 `kindFor()` 排除，因而不能进入 `WorldSnapshot`。
2. **`AttrId` 已与当前可观察属性表发生漂移。** 本次比对发现 18 个上游枚举项未
   转录，其中包括当前回放实际出现的导航能力、导航策略、弹丸命中、击杀、死亡和
   observer deploy mask 等字段。动态 PlayerID band 的逐项键可以只保留范围定义，
   但具名协议字段应有明确的同步策略。
3. **语义投影测试覆盖过低。** 当前 `attributeStore.test.ts` 只有一条 recycle 后重建
   用例；单位分类、引用跟随、隐藏传播、full 替换、position/yaw、Radar、buff、
   修复、弹药和异常输入都没有回归测试。解码器通过不代表 UI 解读正确。

### 中优先级：健壮性与可审计性不足

1. **实时 JSON 只有 TypeScript cast，没有运行时校验。** 未知 `sync_type` 会被当成
   full，非法 map id、非数组结果或非有限属性值也没有在入口统一拒绝并留下诊断。
2. **手写 FlatBuffer 子集与上游 schema 之间没有自动漂移检查。** 当前单测 fixture
   使用与实现相同的一组手写 tag、event id 和表布局；两边一起过时仍可能保持绿灯。
   应增加由权威 schema 生成或校验的契约测试。
3. **快速 metadata scan 的 `frameCount` 是候选 world frame 数，不是精确的
   Attribute-bearing frame 数。** 本次真实样本抽查中，快速扫描与完整解码相差 1 帧。
   这不影响播放，但 UI 和文档不应把前者解释为精确 Attribute 帧数。
4. **RBREPLAY 完整性检查不闭合。** 当前 reader 遇到 footer 会停止，但不验证 footer
   必然存在、footer JSON/计数是否有效或 footer 后是否有尾随数据。若其职责包含文件
   完整性验收，还需要补齐这些检查。
5. **文档与实现存在漂移。** `docs/ARCHITECTURE.md` 仍称只发送一次订阅、只描述
   `sync_type` 0/1，并展示了过时的 `VehicleState` 子集；实际实现会动态追加订阅，
   回放还有 recycle 类型 2，语义字段也更多。

### 一个需要重点回归的状态边界

当隐藏的 player map 在同一 ID 上把 `PlayerBattleAttributeMapID` 从旧值切换到新值时，
当前隐藏集合更新只处理选中的当前引用，旧 battle map 的派生隐藏标记可能残留。旧 ID
后续被复用时可能仍被错误隐藏。应为“隐藏状态 + 引用切换 + ID 复用”增加状态机测试，
再根据测试结果决定修复方式。

## “全面”验收清单

只有以下项目都成立，才建议把链路标记为全面：

- 权威 Attribute ID 表与 Monitor 的同步检查可自动执行，允许的范围型例外有白名单；
- 三类生命周期事件和四类 world packet 都有独立的正向、截断、错 tag/id 与边界测试；
- initial/checkpoint、同帧多 packet、回收后 ID 复用和晚加入 keyframe 有端到端测试；
- 实时入口对 JSON 结构、同步类型、map id 和数值进行运行时校验并输出可定位诊断；
- 每种可观察单位 class（包含 Radar）都有分类测试；
- 每个实际输出的 `VehicleState` 字段至少有一个属性到语义的测试；
- 引用图、隐藏传播、引用切换和 map recycle 有状态机测试；
- 至少保留一个去敏、可公开的真实协议 fixture，防止手写 fixture 与实现一起漂移；
- `npm test`、`npm run typecheck` 和真实构建回放的集成验收全部通过；
- `README.md` 与 `docs/ARCHITECTURE.md` 的协议说明同步到当前实现。

## 常用验证命令

在 Monitor 仓库根目录执行：

```bash
npm run test -w @gsm/agent
npm run test -w @gsm/web
npm run typecheck
```

排查时建议先验证 `rbreplay-world-attributes.test.mjs` 的生命周期事实，再验证
`attributeStore.test.ts` 的业务语义，最后才进入 Three.js 渲染。这样可以快速判断
问题属于“数据没解出来”“状态没还原”还是“语义/画面解释错误”。

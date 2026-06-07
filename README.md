# AI Function for Spark · PRD & Architecture

> 把大模型作为 Spark Catalyst 的一等算子，让数据团队用 SQL 一行调用 AI，
> 享受谓词下推、批量合并、智能路由、状态恢复等数据库级优化。

---

## 0. 项目挑战与收益（TL;DR）

### 0.1 我们解决的核心挑战

| # | 挑战 | 现状（不用本方案）| 痛点 |
| --- | --- | --- | --- |
| **C1** | **LLM 调用成为 SQL 黑盒** | 用 `pandas_udf` 包装 OpenAI 调用 | Catalyst 把 UDF 当 black-box，谓词无法下推、Limit 无法穿透、cache 不识别 |
| **C2** | **任务挂掉重跑要再付一遍钱** | Airflow 重试 = 重新调一遍 LLM | 调用费 / token 配额双重浪费，凌晨任务挂掉损失放大 60×（按一天 1 次重跑/2 月） |
| **C3** | **小模型 vs 大模型手工切换** | 业务硬编码 `if confidence < 0.85: call_large()` | 路由逻辑散落在 SQL 之外，难统一治理 |
| **C4** | **可观测性缺失** | UDF 调用埋点要靠 logger / accumulator | 看不到 token / 路由 / 延迟分布，预算告警靠经验 |
| **C5** | **接入成本高** | 闭源方案要 fork Spark 或上专有引擎（Databricks Photon / Snowflake AI_*）| 云厂商绑定 + 升级困难 |

### 0.2 本项目交付的收益

| # | 收益 | 实证（来自本项目运行时数据）| 对应代码 / 页面 |
| --- | --- | --- | --- |
| **B1** | **零 Spark 源码侵入** | 0 行 Spark 改动；项目独立 1736 行 Scala（5 个 SparkSessionExtensions 标准注入点）| `AIFunctionExtension.scala` · `/architecture` 页 KPI |
| **B2** | **Plan 形态自动改写**：用户写最自然的 SQL，规则替他下推 | EXPLAIN 实测：`LocalLimit` 自动从 AI 之上搬到 AI 之下；运行时 SQLConf `spark.aifn.pushLimit.enabled` 可一键开关 | `PushLimitBeforeAIInference.scala` · TryIt **Act 1/2** |
| **B3** | **行级 + 重启级幂等**：重跑 N 行 = 0 次新调用 | `prompt_hash` 锁定输入↔输出 + Iceberg 持久化；模拟「任务挂掉 → 进程重启 → load cache」后重跑零成本 | `runtime/StateTable.scala` · TryIt **Act 3** |
| **B4** | **可被 Catalyst 全套规则识别** | AIInference 是一等 LogicalPlan，EXPLAIN 显式可见；3 条扩展 Optimizer 规则 + 1 条 PostHoc 规则 + 1 个 Strategy | `logical/AIInference.scala` · `/workspace` EXPLAIN 抽屉 |
| **B5** | **OpenAI 兼容协议**：一份代码同时跑混元 / TokenHub / DeepSeek / OpenAI | 凭证只需 `api_key + base_url`；3 个内置 AI 函数（`ai_classify` / `ai_complete` / `ai_extract`）+ DDL 自定义 | `runtime/HunyuanClient.scala` · `/settings` 页 |
| **B6** | **治理面板开箱即用** | per-model token / 调用次数 / 路由分布 / 平均延迟；按 token 单价折算花费（CNY）| `runtime/Governance.scala` · `/insights` 页 KPI Hero |
| **B7** | **一键卸载** | 去掉 `--conf spark.sql.extensions=...` 即恢复原生 Spark；不需要重装、重打 jar | `/architecture` 页对比表 |

### 0.3 一分钟说清楚

```
用户写最自然的 SQL ─────► Catalyst 标准扩展点（5 个）─────► AI 算子 + 数据库级优化
   SELECT ai_classify(text, ...) FROM reviews LIMIT 3
                              │
                              ▼
   ✓ Plan 自动改写：LocalLimit 搬到 AI 之下     ← PushLimitBeforeAIInference
   ✓ 谓词下推到扫描层                            ← PushDownPredicateThroughAI
   ✓ 行级幂等，prompt_hash 去重                  ← StateTable + Iceberg
   ✓ 智能路由：小模型一击命中 / 升级大模型       ← ModelRouter
   ✓ 治理面板实时看 token / ¥ / 延迟              ← Governance
```

> 📌 下方 §1-§8 为最初 v1 PRD（5 Tab 命名 Workbench/Functions/Monitor/Recovery/Settings）。
> 当前 SPA 已重构为 4 主 Tab：**Try It · Workspace · Insights · Architecture** + 齿轮 Settings；
> 实际页面结构见 `frontend/src/App.tsx` 或访问 http://127.0.0.1:49193。

---

* **默认大模型**：`hy3-preview`（UI 展示名 **Hy3 Preview**）
* **默认小模型**：`hy-mt2-pro`（UI 展示名 **Hy-MT2-Pro**）
* **默认网关**：腾讯云 TokenHub `https://tokenhub.tencentmaas.com/v1`，OpenAI 兼容协议（`Authorization: Bearer ${api_key}`）
* **运行栈**：Spark 3.5.3 · Iceberg 1.6.1 · FastAPI · React 18 + Vite + ECharts + Monaco

---

## 1. 产品定位与价值（PM 视角）

| 维度 | 现状 | 我们解决什么 |
| --- | --- | --- |
| **入口** | 离线 ML 流程要写 PySpark + 自调 OpenAI，重复造轮子 | 用 SQL 一行 `ai_classify(text, ARRAY(...))` 即可 |
| **成本** | 每行直调大模型，重复请求 / 漏命中 / 不会路由 | 内置批量合并 + cascade 路由 + token 预算 |
| **可观测** | 调用散落在 UDF，无法追溯 token / 延迟 / 路由 | 实时 Monitor 面板 · per-call 治理记录 |
| **韧性** | 任务挂掉就要全跑一遍 | 状态表 hash 去重 + Iceberg merge，断点续推 |
| **演进** | 试模型要改代码 | DDL `CREATE OR REPLACE AI FUNCTION` 即时换 prompt/router |

### 1.1 三类用户画像

1. **数据分析师**：Workbench 写 SQL，看结果表 + 物理计划 + EXPLAIN 图，直接判断「下推到没到」
2. **平台工程师**：Settings 配置 ApiKey/网关；Monitor 看 QPS/token；Recovery 看 hash 去重命中率
3. **产品 / 业务方**：Functions 页用 DDL 把 prompt 注册成命名函数，团队可复用

### 1.2 核心场景（v1）

| ID | 场景 | 入口 | 关键能力 |
| --- | --- | --- | --- |
| **S1** | 情感分类 / 意图识别 | Workbench → Sample 1 | `ai_classify` 内置函数 |
| **S2** | 票据 / 评论结构化 | Workbench → Sample 2 | `ai_extract` schema 模板 |
| **S3** | 谓词下推可视化 | Workbench → EXPLAIN 图 | `PushDownPredicateThroughAI` 规则 |
| **S4** | cascade 智能路由 | Workbench → Sample 4 | small→large 动态升级 |
| **S5** | DDL 注册命名函数 | Functions | `CREATE OR REPLACE AI FUNCTION` |
| **S6** | 实时治理面板 | Monitor | `Governance.snapshotJson()` |
| **S7** | 断点续推 | Recovery | `StateTable` hash 去重 + Iceberg merge |
| **S8** | 凭证 / 模型在线切换 | Settings | `.env` 热写 + Spark 重启 |

---

## 2. 信息架构（Information Architecture）

```
Top Nav · 5 个页面 · 单页 SPA
├── Workbench   主战场（SQL 编辑器 + 结果表 + 物理计划图）
├── Functions   AI Function DDL 管理
├── Monitor     治理实时面板（QPS / token / 路由 / 延迟）
├── Recovery    状态表 / Iceberg checkpoint / hash 去重
└── Settings    OpenAI 兼容凭证 + 默认大小模型 + 兜底策略
```

---

## 3. 技术架构（Spark 专家视角）

### 3.1 全景图

```
┌─────────────── Frontend (React + Vite + ECharts + Monaco) ───────────────┐
│ Workbench │ Functions │ Monitor │ Recovery │ Settings                    │
└──────────────┬──────────────────────────────┬─────────────────┬──────────┘
               │ /api/sql           /api/metrics     /api/credentials
               │                                                /api/functions
       ┌───────▼──────────── FastAPI (Python · py4j) ────────────────────┐
       │  routers · pydantic · 写 .env / 重启 Spark / 调 JVM Singleton   │
       └────────┬───────────────────────────────────────────────────────┘
                │ py4j (JVM 单进程 local[*])
       ┌────────▼─────────── Spark 3.5.3  (Catalyst Extensions) ─────────┐
       │  AIFunctionExtension                                             │
       │   ├─ Parser          AIFunctionParser   (CREATE AI FUNCTION DDL) │
       │   ├─ Optimizer Rule  PushDownPredicateThroughAI                  │
       │   │                   MergeAIInvocations                         │
       │   ├─ Cost Model      AICostModel        (token / latency 估算)   │
       │   └─ Strategy        AIInferenceStrategy → AIInferenceExec       │
       │                                                                  │
       │  Runtime singletons (driver + executor 共享 JVM 单例)            │
       │   ├─ HunyuanClient   OpenAI 兼容 HTTP，Bearer ApiKey            │
       │   ├─ Governance      record / snapshotJson / reset             │
       │   ├─ ModelRouter     cascade(small,large,threshold)             │
       │   ├─ DynamicBatcher  batch_max_size + max_wait_ms               │
       │   └─ StateTable      hash 去重 + Iceberg merge                 │
       └─────────────┬──────────────────────────────────────────────────┘
                     │
              ┌──────▼────────┐         ┌────────────────────┐
              │ Iceberg local │         │ TokenHub Gateway   │
              │ ./warehouse   │         │ OpenAI 兼容        │
              └───────────────┘         └────────────────────┘
```

### 3.2 数据流（一次 `SELECT ai_classify(...) FROM reviews WHERE country='US'`）

```
SQL String
  │  AIFunctionParser
  ▼
LogicalPlan(Project[ai_classify(text, ...)] → Filter(country='US') → Iceberg.scan)
  │  PushDownPredicateThroughAI 把 Filter 下推
  ▼
Project[AIInference(text→sentiment)] → Filter↓ pushed → Iceberg.scan(filtered)
  │  MergeAIInvocations 合并同行多次推理
  │  AICostModel 估 token / 延迟 / 路由
  ▼
Strategy → AIInferenceExec
  ├─ DynamicBatcher 16 行一批
  ├─ StateTable hash 去重 → Iceberg merge
  ├─ ModelRouter cascade（小模型先跑 → 置信度低升级大模型）
  ├─ HunyuanClient.chat(model=hy-mt2-pro|hy3-preview)
  └─ Governance.record(model, prompt_tokens, completion_tokens, latency, routed)
```

### 3.3 关键设计决策

| 决策 | 为什么 |
| --- | --- |
| **AIInference 作为一等 LogicalPlan**，而非 ScalaUDF | UDF 是优化器黑盒，无法做谓词下推 / 合并；一等算子可被 Catalyst 全套规则识别 |
| **JVM 单例 Governance / StateTable** | local 模式 driver+executor 同进程；分布式时由 ApplicationMaster 端汇聚（v2 路线） |
| **Jackson `snapshotJson()` 而非 py4j Map** | 嵌套 Map 经 py4j 序列化失败；走 JSON 字符串边界更稳 |
| **OpenAI 兼容协议 + ApiKey 单字段** | 一份代码同时跑混元 / TokenHub / DeepSeek / OpenAI，凭证模型最简（`Authorization: Bearer`） |
| **模型目录 `models_catalog.py`** | UI 展示「Hy3 Preview / Hy-MT2-Pro」，请求规范化成网关 ID `hy3-preview` / `hy-mt2-pro`；阻断「友好名直接发出去 → 网关 400004」 |
| **`AIFN_DEMO_MODE=auto`** | 真实 API 失败时自动 mock，让 demo 始终能跑；严格模式 `false` 强制实测 |

### 3.4 模型目录（友好名 ↔ 网关 ID）

| Size | UI 展示 | 网关 ID | 默认用途 |
| --- | --- | --- | --- |
| Large | **Hy3 Preview** | `hy3-preview` | `ai_extract` / 复杂推理 / cascade large |
| Small | **Hy-MT2-Pro** | `hy-mt2-pro` | `ai_classify` / `ai_complete` / cascade small |
| Backup | MiniMax M3 | `minimax-m3` | 备选小模型 |

> ⚠️ TokenHub 网关只识别**小写连字符**形式（`hy3-preview`），含空格 / 驼峰 / 下划线均会返回 `400004 model not found`。
> 后端 `models_catalog.normalize()` 自动把用户输入规范化。

### 3.5 零侵入设计：为什么能跟开源 Spark 同步迭代

> **一句话**：我们没改 Spark 一行源码，只在 Spark **官方暴露的扩展点**（`SparkSessionExtensions`）上注册了 5 个 hook。
> Spark 升级 → 换二进制即可，不需要重新合并补丁、重 fork、重打 jar。

#### 3.5.1 三个事实（可验证）

| # | 事实 | 凭证 |
| --- | --- | --- |
| **F1** | **没有 fork Spark** | 项目根目录无 `spark/` 子模块；`spark-extension/pom.xml` 中 `spark-core` / `spark-sql` / `spark-catalyst` 依赖全部 `<scope>provided</scope>`，由集群运行时 Spark 提供 |
| **F2** | **没有改过 Spark 任何 jar** | 项目产物只有一个 `aifn-spark-extension-0.1.0.jar`（约 3.3 MB），与 `$SPARK_HOME/jars/*` 完全隔离 |
| **F3** | **加载方式是标准的 plugin 入口** | 启动加 `--conf spark.sql.extensions=org.apache.spark.sql.aifn.AIFunctionExtension` 即生效；去掉这一项，Spark 行为完全恢复成原生 |

#### 3.5.2 5 个标准注入点（全部来自 `SparkSessionExtensions` 官方 API）

`AIFunctionExtension.scala` 全文 59 行，是唯一接入点：

| # | 注入点 | Spark 官方 API | 我们的扩展 |
| --- | --- | --- | --- |
| 1 | **Parser** | `injectParser` | `AIFunctionParser` 扩展 SQL 语法（`CREATE AI FUNCTION` DDL）|
| 2 | **Optimizer Rules** | `injectOptimizerRule` × 3 | `PushDownPredicateThroughAI` / `MergeAIInvocations` / `AICostModel` |
| 3 | **PostHoc Resolution Rule** | `injectPostHocResolutionRule` | `PushLimitBeforeAIInference`（Analyzer 后、Optimizer 前一次性下推 LocalLimit）|
| 4 | **Planner Strategy** | `injectPlannerStrategy` | `AIInferenceStrategy` 把 `AIInference` 逻辑节点翻译成 `AIInferenceExec` 物理算子 |
| 5 | **Function Registry** | `injectFunction` × 3 | `ai_classify` / `ai_complete` / `ai_extract` 内置函数 |

> 这 5 个 API 是 Spark 自 2.2 以来就稳定的扩展契约，跨 Spark 3.x → 4.x 的兼容性由 Spark 团队维护。

#### 3.5.3 与其他方案的对比（Spark 升级时谁更省事）

| 维度 | Fork Spark | 写普通 UDF | **本方案 · Catalyst Extension** |
| --- | --- | --- | --- |
| Spark 源码改动 | 数百~数千行 | 0 行 | **0 行** |
| 升级 Spark 版本 | 重新合并冲突，回归测试 | 重编 UDF jar | **直接换 Spark 二进制** |
| 可被 Catalyst 优化 | ✓ | ✗（UDF 是黑盒）| **✓**（一等 LogicalPlan）|
| 谓词下推 / Limit 下推 | ✓ | ✗ | **✓**（自定义规则）|
| EXPLAIN 可读性 | ✓ | `ScalaUDF#xxx` 看不出是 AI | **✓ `AIInferenceExec`** |
| 卸载 / 回滚 | 回滚 Spark 二进制 | 改 SQL 删 UDF | **去掉 `--conf` 一行配置** |
| 与 Iceberg / Delta 共存 | 重新合并冲突 | 无影响 | **同时启用多个 extension（逗号分隔）** |

我们演示环境就是 Iceberg + 本扩展共用一个 SparkSession：

```bash
--conf spark.sql.extensions=\
  org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions,\
  org.apache.spark.sql.aifn.AIFunctionExtension
```

#### 3.5.4 升级 Spark 3.5 → 3.6 / 4.0 的实际步骤

```bash
# 1. 替换 Spark 二进制
SPARK_HOME=/path/to/spark-3.6.0-bin-hadoop3

# 2. 我们的扩展 jar 不动（除非 SparkSessionExtensions API 变化，2.2+ 至今稳定）
ls spark-extension/target/aifn-spark-extension-0.1.0.jar

# 3. 重启服务
bash scripts/start.sh
```

> ⚠️ 唯一可能要重编的场景：Spark 大版本变化导致 Catalyst 内部树（`LogicalPlan` / `Project` / `LocalLimit` 等）的 case class 字段变更——
> 但这种变更 Spark 团队会保留 binary compatibility（标 `@DeveloperApi`），实际 3.x → 4.x 也没大改这些核心类。
> 如果遇到，重编 spark-extension（一条 `mvn package`）即可。

#### 3.5.5 一键卸载 / 关闭某条规则

| 想做的事 | 做法 |
| --- | --- |
| 完全卸载扩展 | 启动参数去掉 `--conf spark.sql.extensions=...AIFunctionExtension`；Spark 立刻恢复原生 |
| 只关 LIMIT 下推规则（保留其他能力） | `SET spark.aifn.pushLimit.enabled=false`（运行时切换，无需重启）|
| 临时关 cascade 路由 | DDL 注册函数时改成单 model：`USING MODEL 'hy-mt2-pro'`（不走 cascade 解析）|
| 关治理统计 | 不调用 `Governance.snapshotJson()` 即可；无副作用 |

### 3.6 三个核心 Runtime 组件深度分析

> 本节聚焦 `AIInferenceExec` 物理算子内部协同的三个 JVM Singleton：
> **DynamicBatcher**（攒批）· **StateTable**（行级幂等）· **ModelRouter**（智能路由）。
> 每个组件按「痛点 → 原理（含真实代码位置）→ 效果 → 局限 → 与业界对比」5 段展开。

#### 3.6.1 DynamicBatcher · 三维触发的 partition 内攒批

##### 痛点

- **直调 LLM = 一行一次 HTTP**：100 行 → 100 个 round-trip，网络 RTT 主导耗时
- **固定大小批**：`batch_size=16` 死命攒，最后一批不足 16 行就一直等 → 长尾延迟
- **只看条数**：一批里如果有几条超长 prompt，攒到 16 行 prompt token 总量爆 8000，被网关 413 退回

##### 原理

`DynamicBatcher.scala` 用**三维 OR** 触发 flush（line 36）：

```scala
if (buf.size >= maxSize || bufTokens + est > maxTokens) flush()
buf.append((idx, prompt, hash))
bufTokens += est
```

| 维度 | 默认值 | 来源 | 触发场景 |
| --- | --- | --- | --- |
| `batch_max_size` | 16 行 | `batch_max_size` option | 普通短 prompt 攒批主导维度 |
| `batch_max_tokens` | 8000 tokens | `batch_max_tokens` option | 长 prompt 提前 flush，避免网关 413 |
| `batch_max_wait_ms` | 200 ms | `batch_max_wait_ms` option | 流式场景下控制最末批延迟（demo 内退化为「最多扫一次完成」）|

token 估算用极简启发式（line 44）：`max(1, prompt.length / 3)` —— 中英混合下平均 1 字符 ≈ 0.3 token，足够保守。

调用栈：`AIInferenceExec.doExecute` → `mapPartitions` 内构造 batcher（line 50）→ 收集本 partition 全部 pending → `runBatch(pending) { prompts => router.routeBatch(...) }`。

##### 效果

> 注：以下数字分两栏 —— **本 demo 实测**（mock 模式 latency=5ms）和**生产估算**（按真实 LLM RTT≈300ms 推算）。
> 项目运行可在 http://127.0.0.1:49193/insights 看实时累计指标。

| 场景 | demo 实测（mock）| 生产估算（真实 RTT 300ms）| 备注 |
| --- | --- | --- | --- |
| 100 行短 prompt · 不攒批 | ~500 ms | ~30s | 100 RTT 串行主导 |
| 100 行短 prompt · DynamicBatcher（默认 16）| **~1046 ms（首次跑）** | ~3.5s（≈ 7 批 × 500ms）| 实测来自 100 条 reviews `ai_classify`，**首次跑 cache miss** |
| 100 行 · cache 全命中（重跑）| **~94 ms** | ~94 ms（lookup 不走网络）| 行级幂等命中，**实测真实数据** |
| 50 行长 prompt（每行 200 tokens）| - | 按 token 维度切批 ≈ 12 批 | 防止单批超 8K 被网关 413 |
| 极端：1 行超长（10K tokens）| - | 单行触发 token 上限，单独一批 | 安全降级，不连累其他行 |

**关键观察**：
- 行级幂等加速 = **~11×**（1046ms → 94ms，cache miss vs cache hit）— 实测稳定可复现
- DynamicBatcher 在 demo 模式下加速不明显（mock 没 RTT），生产模式预计 **~9×**（按 100 行短 prompt 估算）

##### 局限

- **demo 是 partition 内同步**：`maxWaitMs` 退化为「最多扫一次完成」（注释明示，line 12-13）。生产场景如果想要异步流式攒批，要把 batcher 抽到独立 actor，跨 partition 共享配额池。
- **token 估算粗糙**：`length/3` 不区分中英。生产建议接 tiktoken 之类的 BPE tokenizer 算精确。
- **没有 backpressure**：batcher 不感知下游 LLM 限流（429）。生产建议加 token bucket + 指数退避。

##### 与业界对比

| 方案 | 攒批策略 |
| --- | --- |
| 普通 PySpark `pandas_udf` | 按 Arrow batch size（默认 10000）盲攒，无 token 维度 |
| Databricks `ai_query` | 黑盒固定 batch_size，不暴露 token 维度 |
| **本方案** | **三维 OR 触发**，可在 SQL options 调每个维度 |

---

#### 3.6.2 StateTable · 双层缓存 + 行级幂等的代价

##### 痛点

- **任务重跑 = 重新付费**：Airflow 默认重试 3 次 → 每次都重新调 LLM，token 配额翻 3 倍
- **进程重启 = cache 全丢**：Driver OOM 重启后，内存缓存清零，几小时辛苦计算的"已处理行"白费
- **集群分布式写冲突**：每个 executor 独立写 Iceberg → MERGE 冲突 / 长尾事务

##### 原理

`StateTable.scala` 设计的核心是 **「Executor 端读写都进内存，Driver 端批末写盘」** —— 把分布式写冲突收敛到 Driver 单点：

```
Executor JVM (× N)                  Driver JVM
─────────────────                  ──────────────
ConcurrentHashMap         ←──────  loadFromDelta() 启动时一次性加载
   │
   ├ lookup(hash)         →  Some/None      (line 44)
   ├ upsert(hash, ...)    →  put cache + audit append  (line 46-51)
                              │
                              ▼
                          ConcurrentLinkedQueue<AuditEntry>
                              │
                              ▼ Driver 调用 flushToDelta() 时
                          drainAudit() → Iceberg MERGE INTO
```

##### 三个关键设计决策

1. **进程级 `globalCache`（line 59）** = JVM 单例 ConcurrentHashMap
   - **原因**：local 模式 driver+executor 同 JVM；分布式 broadcast cache 太大，partition 共享同 JVM 缓存即可
   - **代价**：Executor 间不共享（v2 路线：driver 端汇总）

2. **Hash 是 SHA-256(funcName | model | prompt)**（line 34-42）
   - **原因**：funcName 区分 `ai_classify` vs `ai_complete`；model 区分小/大模型；prompt 是真正的输入
   - **代价**：完全相同 prompt 但 model 字符串不同（如 "cascade(...)" vs "hy-mt2-pro"）会算出不同 hash → cache miss
   - **当前实现**：`AIInferenceExec` 用 cascade 字符串算 hash，`HunyuanClient.completeWith` 用真实 model 算 hash，**两层 hash 不一致**（已知局限，下面"局限"段细说）

3. **MERGE INTO + ROW_NUMBER 去重（line 151-170）**
   - **原因**：audit 累积里同一 hash 可能多次（重跑 / cache_hit 也 append audit）
   - **修复**：source 子查询 `ROW_NUMBER() OVER (PARTITION BY prompt_hash ORDER BY ts DESC) WHERE rn=1`
   - **背景**：之前一版没去重，触发 `MERGE_CARDINALITY_VIOLATION`（commit `ffeb565` 修复）

##### 效果

实测（100 条 reviews · `ai_classify` · demo mode auto · `commit 13760fe` 后采集）：

| 步骤 | 真实 LLM 调用 | Tokens | Spark elapsed | wall clock |
| --- | --- | --- | --- | --- |
| 第一次跑 100 行（cache miss）| 100（demo 路径）| **7421** | **1046 ms** | 1079 ms |
| **重跑同一条 SQL（cache hit）** | **0** ✓ | **0** ✓ | **94 ms** | 126 ms |
| flush → 清 cache → load 后再跑 | **0** ✓ | **0** ✓ | ~80 ms | ~110 ms |

`cache_hit` 在 `routed_distribution` 单独计数，**不计入 `total_calls`**（commit `ffeb565` 修复）。
节省金额（按 hy-mt2-pro ¥0.001/1k tokens 计）：单次重跑省 **¥0.0074**，每天若因任务挂掉重跑 60 次 ≈ **¥0.44/月**（按当前 100 行规模）。
若业务量是当前 100×（每天 1 万行），**~¥44/月**；100 万行规模下 **~¥4400/月**。

##### 局限

- **双层 hash 不一致**：`AIInferenceExec` 物理层 cache 用的 model 字符串是 cascade 原文（`cascade(small=...)` 整段），而 `HunyuanClient.completeWith` 内部 cache 用的是真实模型 ID。这导致**第二次跑同一条 SQL 时第一层 lookup 不命中**，会 fall through 到 ModelRouter → HunyuanClient 第二层 cache 才命中。功能上没有错（最终 cache 命中、token=0），但调用栈比理想多一层。修法：让两层都用 `(funcName, real_model, prompt)` 算 hash，需要 ModelRouter 提前 resolve cascade。
- **prompt 必须 row-deterministic**：如果 prompt 模板里有时间戳 / 随机数，hash 每次都不同 → cache 永远不命中。当前 `PushLimitBeforeAIInference` 规则会过滤掉含 `rand()` 的表达式，但用户在 DDL 里写 `now()` 我们没拦。
- **进程级缓存 ≠ 分布式共享**：spark.executor.instances > 1 时，每个 executor 独立维护一份缓存，第一次跑分散在多个 executor 上，第二次跑可能命中不同 executor → cache miss。生产路线：Driver 端 broadcast 或外置 Redis。
- **MERGE 去重靠 ts 排序**：极端并发下两条同 hash 的 audit ts 相同，ROW_NUMBER 排序不稳定。当前不影响正确性（任何一条都对），但 audit 日志的 timestamp 会被覆盖。

##### 与业界对比

| 方案 | 行级幂等机制 |
| --- | --- |
| Snowflake `TRY_COMPLETE` | 只给 status 列，重跑无幂等 |
| BigQuery `ml_generate_text_status` | 同上，状态列而非缓存 |
| Databricks `ai_query` | 黑盒，文档没有提到 cache 语义 |
| **本方案** | **prompt_hash 去重 + Iceberg 持久化 + 一键 Replay** |

---

#### 3.6.3 ModelRouter · 小→大级联的"自适应"细节

##### 痛点

- **硬编码模型 = 全用大模型**：业务图省事一律用 GPT-4，简单分类任务也烧 30× 成本
- **静态阈值 = 固定 if-else**：`if confidence > 0.85: use_small()` 散落在业务代码里，难统一治理
- **失败兜底缺失**：小模型 5xx → 业务直接报错，不会自动升级到大模型

##### 原理

`ModelRouter.scala` 用**两阶段决策**（line 21-43）：

```scala
def routeBatch(prompts: Seq[String], client, gov): Seq[String] = {
  prompts.map { p =>
    val r1 = Try(client.complete(p, small, jsonMode)).toOption
    r1 match {
      case Some(res) if confident(res.text) =>
        gov.record(small, ..., "small_only");   res.text  // ① 一击命中
      case Some(res) =>
        val r2 = client.complete(p, large, jsonMode)
        gov.record(large, ..., "upgraded");     r2.text   // ② 升级到大
      case None =>
        val r2 = client.complete(p, large, jsonMode)
        gov.record(large, ..., "fallback");     r2.text   // ③ 失败兜底
    }
  }
}
```

| 路径 | 触发条件 | 计入 `routed_distribution` |
| --- | --- | --- |
| **small_only** | 小模型成功 + `confident()` 通过 | `small_only` |
| **upgraded** | 小模型成功但置信度不够 | `upgraded` |
| **fallback** | 小模型抛异常（5xx / 超时）| `fallback` |
| **failed** | 大模型也失败 | `failed`（外层捕获）|

`confident()` 函数（line 45-55）：

```scala
private def confident(text: String): Boolean = {
  if (text == null || text.trim.isEmpty) return false
  if (jsonMode) {
    try { mapper.readTree(text); true }       // JSON 能解析就算可信
    catch { case _: Throwable => false }
  } else {
    text.trim.length > 1                       // 文本模式：长度 > 1 字符
  }
}
```

##### 解析的 DSL：`cascade(small=hy-mt2-pro, large=hy3-preview, threshold=0.85)`

`ModelRouter.fromOptions`（line 64-72）按正则 `cascade\(small=(.+),\s*large=(.+),\s*threshold=([0-9.]+)\)` 解析；不匹配则退化为单模型模式（永远不升级，全打 `small_only`）。

##### 效果

实测（demo mode auto，100 条 reviews 情感分类）：

| 路由路径 | 调用次数（实测）| 占比 |
| --- | --- | --- |
| small_only | ~95 | 95% |
| upgraded | ~3 | 3% |
| fallback | ~2 | 2% |
| failed | 0 | 0% |

成本意义（按 hy-mt2-pro ¥0.001/1k vs hy3-preview ¥0.012/1k 计）：

- **全用大模型**：100 行 × ~80 tokens × ¥0.012/1k = **¥0.096**
- **cascade**：95×小 + 5×大 = **¥0.013**（节省约 86%）

##### 局限

- **`confident()` 太朴素**：当前只看「JSON 是否能解析」/「文本长度 > 1」。生产建议接 logprobs / PPL 估算，或多模型 self-consistency。
- **不考虑历史**：每行独立决策，不能利用「同 batch 前 100 行 small 都命中 → 后面更激进用 small」的在线学习。生产路线：Thompson sampling / 多臂 bandit。
- **cascade 不级联多于 2 层**：当前只支持 small→large。如果想做 small→medium→large 三级，要改 DSL 和路由分支。
- **threshold 参数读了但没用**：当前 `confident()` 是布尔判断，没用 `threshold` 浮点值；将来接 logprobs 时才会真正用上。

##### 与业界对比

| 方案 | 路由能力 |
| --- | --- |
| Databricks `ai_query` | 单模型模式，必须用户硬编码 |
| Snowflake Cortex | 同上 |
| OpenAI gateway 商品 | 静态权重路由（70% A, 30% B），不看置信度 |
| **本方案** | **小→大级联，置信度触发升级，可在 DDL 里声明，治理面板实时看分布** |

---

---

## 4. 快速开始

```bash
cd ai-function-demo

# 1. 装依赖（首次）
bash scripts/build.sh        # 构建 spark-extension JAR + 前端 vite build

# 2. 启动（同时拉起 FastAPI 后端 + Vite dev server）
bash scripts/start.sh

# 3. 打开浏览器
open http://127.0.0.1:49193
```

### 4.1 配置 ApiKey（首次必填）

进入 **Settings** 页 →

* ApiKey：`sk-xxxx`（前往 [TokenHub 控制台](https://console.cloud.tencent.com/lkeap) 创建）
* Base URL：默认 `https://tokenhub.tencentmaas.com/v1`
* Small Model：`hy-mt2-pro`（点 chip 即可填）
* Large Model：`hy3-preview`
* Demo Mode：`auto`（推荐）

点 **测试连接** 看到 `✓ 真实调用成功` 即生效；点 **保存并重启 Spark** 落 `.env` + 重启 SparkSession。

### 4.2 跑一遍核心 demo

```sql
-- Workbench → Sample 1
SELECT id, text, ai_classify(text, array('正面','负面','中性')) AS sentiment
FROM reviews LIMIT 10;
```

回到 **Monitor** 页应该能看到：
* total_calls > 0
* 模型分布：`hy-mt2-pro: N`
* prompt/completion tokens 正常累计

点 **EXPLAIN** 切「图形」看物理计划，会看到 Filter 被下推到 `AIInferenceExec` 之下。

---

## 5. 路线图（Roadmap）

| 版本 | 主题 | 关键功能 |
| --- | --- | --- |
| **v1.0**（当前）| 单机 demo + 治理面板 | local[*] · OpenAI 兼容 · 5 页 SPA · hash 去重 |
| v1.1 | 分布式治理 | per-executor accumulator → driver 聚合 |
| v1.2 | 多模型 / 多租户 | 模型目录持久化 · 租户级 quota · 审计日志 |
| v2.0 | 真分布式 + 状态服务 | 状态表迁 RocksDB + Iceberg snapshot · 端到端 exactly-once |

---

## 6. 目录结构

```
ai-function-demo/
├── backend/                  FastAPI · py4j 桥到 Spark
│   ├── app/
│   │   ├── api/              5 个 router (sql / functions / metrics / recovery / credentials)
│   │   ├── spark/session.py  build_spark + executorEnv 透传
│   │   ├── demo/seed.py      30 条 reviews + 20 条 tickets
│   │   ├── models_catalog.py 友好名 ↔ 网关 ID 单一来源
│   │   ├── config.py         pydantic settings
│   │   └── main.py           FastAPI 入口 / lifespan
│   └── .env                  ApiKey / 默认模型
├── spark-extension/          Scala · Catalyst Extensions
│   └── src/main/scala/org/apache/spark/sql/aifn/
│       ├── AIFunctionExtension.scala   注册入口
│       ├── parser/                     AI FUNCTION DDL
│       ├── logical/AIInference.scala   逻辑算子
│       ├── physical/AIInferenceExec.scala
│       ├── optimizer/                  PushDownPredicate / MergeAI
│       ├── strategy/AIInferenceStrategy.scala
│       ├── expressions/                ai_classify / ai_complete / ai_extract
│       └── runtime/                    HunyuanClient · Governance · ModelRouter · StateTable
├── frontend/                 React 18 · Vite · Tailwind · ECharts · Monaco
│   └── src/pages/{Workbench,Functions,Monitor,Recovery,Settings}.tsx
├── scripts/{build,start}.sh
├── warehouse/                Iceberg local catalog
└── README.MD                 本文件
```

---

## 7. 重构变更清单（本次迭代）

* [+] `backend/app/models_catalog.py` 新增模型目录 + `normalize()`
* [~] 默认模型统一切到 `hy-mt2-pro` / `hy3-preview`，覆盖：
  * `backend/.env`
  * `backend/app/config.py`
  * `backend/app/api/credentials.py`（CredentialsPayload + PUT 规范化 + test 规范化）
  * `frontend/src/pages/Settings.tsx`（initial + MODEL_PRESETS chip 选择器）
  * `frontend/src/pages/Workbench.tsx`（Sample 4 cascade 写法）
  * `frontend/src/pages/Functions.tsx`（DDL 默认 model）
  * `spark-extension/.../expressions/{AIClassify,AIComplete,AIExtract}.scala`（fallback 默认值）
* [+] `GET /api/credentials/models` 端点暴露目录 + 当前默认
* [~] BASE_PRESETS 把 TokenHub 提到第一位（与默认 `.env` 一致）

---

## 8. 已知限制 / 注意事项

* **凭证只走环境变量**：local 模式 driver/executor 同 JVM；分布式时需要 `spark.executorEnv.*` 透传（已实现）。
* **Monitor 数据为 JVM 单例**，进程重启后清零（点 Monitor 页的「重置」即可主动清）。
* **TokenHub `/v1/models` 不开放**：模型目录只能客户端维护，不能动态拉。
* **`AIFN_DEMO_MODE=auto`** 时真实调用失败会无声降级到 mock；要确认真实 API，请切到 `false` 严格模式。

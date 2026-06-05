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
> 实际页面结构见 `frontend/src/App.tsx` 或访问 http://127.0.0.1:5193。

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

---

## 4. 快速开始

```bash
cd ai-function-demo

# 1. 装依赖（首次）
bash scripts/build.sh        # 构建 spark-extension JAR + 前端 vite build

# 2. 启动（同时拉起 FastAPI 后端 + Vite dev server）
bash scripts/start.sh

# 3. 打开浏览器
open http://127.0.0.1:5193
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

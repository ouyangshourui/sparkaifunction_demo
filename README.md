# Spark SQL · AI Function Demo

> 把大模型变成 **Spark Catalyst 的一等公民**——`AIInference` LogicalPlan + `AIInferenceExec` 物理算子 + 自定义优化器规则；不是普通 UDF。

通过修改 Spark 内核（`SparkSessionExtensions` 机制）把 `ai_classify` / `ai_complete` / `ai_extract` 注册成 Catalyst 表达式，实现 **谓词下推 / 语义合并 / 智能路由 / 行级幂等恢复**。

---

## 技术栈

| 组件 | 版本 / 路径 |
|---|---|
| Apache Spark | **3.5.3** |
| Scala | 2.12 |
| Iceberg | 1.6.1（替代 Delta，hadoop catalog） |
| Hunyuan API | `hunyuan.tencentcloudapi.com` 腾讯云 V3 签名 (TC3-HMAC-SHA256) |
| Backend | FastAPI + PySpark 3.5.3 (Python 3.13) |
| Frontend | React + Vite + Monaco + ECharts |
| 端口 | Backend `:8088` · Frontend `:5193` |

---

## 架构

```
┌────────────────────────────────────────────────────────────────────────┐
│  Frontend (React + Vite + Monaco + ECharts)                  :5193     │
│   Workbench │ Functions │ Monitor │ Recovery                           │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ REST + SSE
┌──────────────────────────────▼─────────────────────────────────────────┐
│  Backend (FastAPI + PySpark 3.5.3)                           :8088     │
│   /api/sql/execute  /api/functions  /api/metrics  /api/recovery/*      │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ PySpark · spark.sql.extensions
┌──────────────────────────────▼─────────────────────────────────────────┐
│  Spark Engine 3.5.3 (本地 standalone)                        :4040     │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Catalyst 扩展（spark-extension/target/*.jar）                    │  │
│  │  ├─ Parser  : ANTLR4 grammar — CREATE AI FUNCTION DDL             │  │
│  │  ├─ Logical : AIInference 节点                                   │  │
│  │  ├─ Optimizer Rules:                                              │  │
│  │  │    • PushDownPredicateThroughAI                                │  │
│  │  │    • MergeAIInvocations                                        │  │
│  │  │    • AICostModel                                               │  │
│  │  ├─ Strategy: AIInferenceStrategy → AIInferenceExec              │  │
│  │  └─ Runtime : DynamicBatcher · ModelRouter · StateTable · Gov    │  │
│  │              StateTable 通过 MERGE INTO 落 Iceberg               │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ HTTPS · TC3-HMAC-SHA256
                       Tencent Hunyuan API
                 (hunyuan-pro / hunyuan-lite / hunyuan-turbo)
```

---

## 一键启动（推荐）

```bash
# 1. 克隆 + 配置
git clone https://github.com/ouyangshourui/sparkaifunction_demo.git
cd sparkaifunction_demo
cp .env.example backend/.env
# 编辑 backend/.env 填入腾讯云 SecretId/SecretKey
#   HUNYUAN_SECRET_ID=AKID...
#   HUNYUAN_SECRET_KEY=...

# 2. 一键启动（自动编译 jar + 起后端 + 起前端）
bash scripts/start.sh
```

打开 **http://127.0.0.1:5193** 即可。

> 前置依赖：JDK 17、Maven 3.9+、Python 3.13、Node 20+。
> 强制重编 jar：`bash scripts/start.sh --rebuild`

---

## 手动启动（分步）

### 1. 编译 Spark 扩展 jar

```bash
bash scripts/build.sh
# 输出 spark-extension/target/aifn-spark-extension-0.1.0.jar (≈3.3MB)
```

### 2. 启动后端 (FastAPI :8088)

```bash
cd backend
python3 -m venv .venv
./.venv/bin/pip install -U pip
./.venv/bin/pip install \
    "fastapi" "uvicorn[standard]" "python-dotenv" "pydantic-settings" \
    "pyspark==3.5.3" "pandas>=2.0" "pyarrow>=14" "packaging" "setuptools<70"

# distutils 兼容补丁（Python 3.12+ 必须）
grep -rl "from distutils" .venv/lib/python*/site-packages/pyspark/ 2>/dev/null | \
  xargs -I{} sed -i '' 's|from distutils\.version import LooseVersion|from packaging.version import Version as LooseVersion|g' {}

./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8088
```

### 3. 启动前端 (Vite :5193)

```bash
cd frontend
npm install
npm run dev   # 等价于 vite --port 5193
```

---

## 健康检查

```bash
# 后端
curl http://127.0.0.1:8088/api/health
# {"status":"ok","spark_version":"3.5.3"}

# AI 函数注册
curl http://127.0.0.1:8088/api/functions
# [{"name":"ai_classify",...},{"name":"ai_complete",...},{"name":"ai_extract",...}]

# Iceberg 表
curl -X POST http://127.0.0.1:8088/api/sql/execute \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT count(*) FROM reviews"}'
# {"columns":["count(1)"],"rows":[[30]],...}
```

---

## 4 个演示场景

| # | 场景 | SQL | 看点 |
|---|------|-----|------|
| 1 | 基础调用 | `SELECT ai_classify(text, array("positive","negative")) FROM reviews` | Monitor token / qps |
| 2 | 谓词下推 | `EXPLAIN SELECT ai_classify(text, ...) FROM reviews WHERE lang='zh'` | `BatchScan ... [filters=lang='zh']` |
| 3 | 智能路由 | `ai_classify(text, labels, 'hunyuan-lite')` 第三参数选模型 | 路由分布饼图 |
| 4 | 行级恢复 | 改错 Key 跑 → 改回 Replay | hash 命中不重复扣费（Iceberg MERGE INTO） |

---

## 项目结构

```
ai-function-demo/
├── spark-extension/          # ⭐ 修改 Spark 内核：Scala + ANTLR
│   ├── pom.xml               #   Spark 3.5.3 + Iceberg 1.6.1
│   └── src/main/
│       ├── antlr4/           #   AI FUNCTION DDL grammar
│       └── scala/
│           ├── parser/       #   AIFunctionParser → SparkSqlParser delegate
│           ├── plan/         #   AIInference LogicalPlan
│           ├── optimizer/    #   PushDownPredicateThroughAI / MergeAIInvocations
│           ├── strategy/     #   AIInferenceStrategy → AIInferenceExec
│           ├── expressions/  #   AIClassify / AIComplete / AIExtract
│           └── runtime/      #   HunyuanClient (TC3 V3) / StateTable (Iceberg MERGE)
├── backend/                  # FastAPI + PySpark
│   ├── app/spark/session.py  #   SparkSession + Iceberg catalog 配置
│   ├── app/api/              #   /sql /functions /metrics /recovery
│   └── app/demo/seed.py      #   30 reviews + 20 tickets 写入 Iceberg
├── frontend/                 # React + Vite + Monaco
├── scripts/
│   ├── build.sh              #   mvn package
│   └── start.sh              #   一键启动
└── .env.example              #   腾讯云密钥模板
```

---

## 关键技术点

1. **Iceberg hadoop catalog**：`spark.sql.catalog.local=SparkCatalog`，`type=hadoop`，无需外部元数据库
2. **`spark.sql.defaultCatalog=local`**：让裸表名 `SELECT * FROM reviews` 直接命中 `local.default.reviews`
3. **MERGE INTO 状态表**：`USING iceberg` 原生支持 v2 MERGE 语法
4. **腾讯云 V3 签名**：`HunyuanClient.scala` 用 TC3-HMAC-SHA256 直接调 `hunyuan.tencentcloudapi.com`，不依赖 OpenAI 兼容入口
5. **distutils 兼容**：Python 3.12+ 删除了 `distutils`，需把 PySpark 内 `from distutils.version` 替换为 `packaging.version`

---

## License

Apache 2.0

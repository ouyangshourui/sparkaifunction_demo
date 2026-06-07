# Backend (FastAPI + PySpark)

启动 SparkSession 时通过 `spark.sql.extensions` 加载我们写的 Scala Catalyst 扩展 jar；
所有 SQL 调用在 Spark 内核侧完成，包括 AIInferenceExec 物理算子、谓词下推、语义合并、行级幂等、模型路由。

## 启动

**推荐**直接用项目根的一键脚本（自动编 jar / 准备 venv / 拉前端）：

```bash
cd ..                       # 回到项目根
bash scripts/dev.sh         # 启动后端 49088 + 前端 49193
```

仅手动跑 backend：

```bash
# 0) 先编译扩展 jar（第一次或源码改了）
cd ../spark-extension && mvn -B -q -DskipTests clean package

# 1) backend 同级有 .env（首次复制 .env.example 到 backend/.env 再编辑）
cd ../backend
cp ../.env.example .env

# 2) venv（一次性）
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install fastapi 'uvicorn[standard]' pyspark==3.5.1 pydantic pydantic-settings \
  python-dotenv sse-starlette openai httpx pandas pyarrow packaging

# 3) 启动
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 49088 --log-level warning
```

启动后端会自动：

1. 构建 SparkSession（加载 spark-extension jar + Iceberg runtime）
2. 写入演示数据 `local.default.reviews`（100 条）/ `local.default.tickets`（20 条）（Iceberg 表）
3. 从 `local.default.ai_inference_state` replay 历史 prompt_hash → output 缓存

## REST API（6 个 router）

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/sql/execute` | 执行 SQL（支持多语句 `;` 分隔，只取最后一条结果集） |
| POST | `/api/sql/explain` | 拿四段计划：parsed / analyzed / optimized / physical + split mode（baseline ↔ pushdown 对比） |
| GET  | `/api/functions` | 列已注册 AI 函数 |
| POST | `/api/functions` | DDL CREATE AI FUNCTION |
| GET  | `/api/metrics` | 指标快照（per-model token / call / latency / 路由分布） |
| POST | `/api/metrics/reset` | 清零内存指标 |
| GET  | `/api/metrics/stream` | SSE 实时流 |
| GET  | `/api/recovery/state` | 缓存视图（cached / persisted / sample） |
| POST | `/api/recovery/{flush-delta,clear,load-delta,replay}` | 行级幂等控制：刷 Iceberg / 清内存 / 加载 / 全套 replay |
| GET  | `/api/credentials` | 当前凭证（半掩码） |
| PUT  | `/api/credentials` | 写入新凭证（仅 ApiKey/base_url/模型 id 真变化时重启 Spark） |
| POST | `/api/credentials/test` | 用请求体凭证发一次真实 chat 调用；`endpoint=chat\|responses` 二选一 |
| GET  | `/api/credentials/models` | 模型目录（友好名 ↔ 网关 ID） |
| GET  | `/api/architecture` | 自描述（5 扩展点 + 3 组件 + Spark 元数据），驱动 `/architecture` 页 |
| GET  | `/api/health` | health check |
| GET  | `/api/spark-ui-url` | Spark UI 链接（`http://127.0.0.1:4040`，首次 SQL 后才出现） |

## 关键模块

| 文件 | 职责 |
| --- | --- |
| `app/main.py` | FastAPI 入口 / lifespan（拉起 SparkSession）/ CORS（49193） |
| `app/spark/session.py` | `build_spark()`：加载 jar + executorEnv 透传 ApiKey + Iceberg 配置 |
| `app/api/credentials.py` | 凭证 CRUD + 测试连接（chat/responses 双端点 + 非 ASCII 三层防御） |
| `app/api/sql.py` | `_split_statements()` 多语句切分（注释 / 字符串感知）；EXPLAIN split mode |
| `app/demo/seed.py` | 100 条 reviews / 20 条 tickets demo 数据 |
| `app/models_catalog.py` | 模型目录单一来源（前后端共用） |
| `app/config.py` | pydantic settings（`AIFN_DEMO_MODE` 默认 `false`） |

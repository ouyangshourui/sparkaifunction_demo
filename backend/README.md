# Backend (FastAPI + PySpark)

启动 SparkSession 时通过 `spark.sql.extensions` 加载我们写的 Scala Catalyst 扩展 jar；
所有 SQL 调用在 Spark 内核侧完成，包括 AIInferenceExec 物理算子、谓词下推、语义合并、行级幂等、模型路由。

## 启动

```bash
# 0. 先编译扩展 jar
cd ../spark-extension && mvn package -DskipTests

# 1. 准备环境变量
cd ../backend
cp ../.env.example ../.env  # 编辑 HUNYUAN_API_KEY

# 2. 安装依赖（uv 推荐）
uv sync

# 3. 启动
export HUNYUAN_API_KEY=sk-xxx
uv run uvicorn app.main:app --reload --port 8000
```

启动后端会自动：
1. 构建 SparkSession（加载扩展 jar）
2. 写入演示数据 `reviews` / `tickets`（Delta 表）
3. 暴露 REST API：
   - `POST /api/sql/execute` 执行 SQL
   - `POST /api/sql/explain` 拿物理计划（看 AIInferenceExec / Filter pushed 进 child）
   - `GET  /api/functions` 列函数
   - `POST /api/functions` CREATE AI FUNCTION
   - `GET  /api/metrics` 当前指标快照
   - `GET  /api/metrics/stream` SSE 实时流
   - `POST /api/recovery/replay` 重放失败行
   - `GET  /api/recovery/state` 状态表缓存

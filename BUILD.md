# 编译 & 启动手册（Spark 3.5.8 内置版）

> 本工程把 `spark-3.5.8-bin-hadoop3.tgz` 解压到 `spark-dist/`，**无需系统装 Spark**；
> 但仍需要 **JDK 17 + Maven 3.8+** 编译扩展 jar。

## 0. 一次性环境准备

### macOS / Apple Silicon（推荐 brew）

```bash
# JDK 17
brew install --cask temurin@17

# Maven
brew install maven

# 验证
/usr/libexec/java_home -V        # 看到 17.x
mvn -v                           # 看到 Apache Maven 3.x
```

如果 `java_home` 找不到 17，往 `~/.zshrc` 加：

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export PATH=$JAVA_HOME/bin:$PATH
```

### Linux（sdkman 一把梭）

```bash
curl -s "https://get.sdkman.io" | bash
source ~/.sdkman/bin/sdkman-init.sh
sdk install java 17.0.10-tem
sdk install maven 3.9.6
```

### Python 3.10+（PySpark 端要用）

```bash
brew install python@3.10
python3 -m venv ai-function-demo/.venv
source ai-function-demo/.venv/bin/activate
pip install -e ai-function-demo/backend
pip install pyspark==3.5.8 fastapi uvicorn[standard] sse-starlette \
            python-dotenv openai delta-spark==3.2.0
```

> ⚠️ 注意：`pyspark==3.5.8` 必须与 `spark-dist/spark-3.5.8-bin-hadoop3` 版本严格一致。

### Node.js 20+（前端）

```bash
cd ai-function-demo/frontend
npm install
```

---

## 1. 编译扩展 jar

```bash
cd ai-function-demo/spark-extension
mvn clean package -DskipTests           # 仅编译，跳过单测
# 或
mvn clean package                       # 编译 + 跑 ScalaTest
```

成功后产物：

```
spark-extension/target/aifn-spark-extension-0.1.0.jar     # ← shade 后的 fat jar
```

里面包含：

- `org.apache.spark.sql.aifn.*`（自定义 Catalyst 扩展）
- `shaded.aifn.okhttp3.*` / `shaded.aifn.okio.*`（重命名后的 HTTP 客户端，避免与 Spark 冲突）
- `org.apache.spark.sql.aifn.parser.gen.*`（ANTLR4 自动生成的 Lexer/Parser）

### 单元测试详情

```bash
mvn test                                # 跑全部测试
mvn test -Dsuites=org.apache.spark.sql.aifn.optimizer.PushDownPredicateThroughAISuite
```

包含 3 个 Suite：

| Suite | 验证 |
|------|------|
| `PushDownPredicateThroughAISuite` | 谓词下推规则（3 case：纯下推 / 纯保留 / AND 拆分） |
| `MergeAIInvocationsSuite` | 同行多调用合并（3 case：合并 / 不同模型不合 / merge_disabled 不合） |
| `AIFunctionExtensionSuite` | extension 注册闭环（基本 SQL / 内置函数注册 / DDL 解析） |

测试报告：`spark-extension/target/scalatest-reports/`

---

## 2. 启动 Spark SQL（命令行验证）

```bash
cd ai-function-demo
export HUNYUAN_API_KEY=sk-xxx
export AIFN_JAR=$(pwd)/spark-extension/target/aifn-spark-extension-0.1.0.jar

./spark-dist/spark-3.5.8-bin-hadoop3/bin/spark-sql \
  --conf spark.sql.extensions=org.apache.spark.sql.aifn.AIFunctionExtension \
  --conf spark.jars=$AIFN_JAR \
  --conf spark.driver.extraClassPath=$AIFN_JAR \
  --packages io.delta:delta-spark_2.12:3.2.0 \
  --conf spark.sql.extensions=io.delta.sql.DeltaSparkSessionExtension,org.apache.spark.sql.aifn.AIFunctionExtension \
  --conf spark.sql.catalog.spark_catalog=org.apache.spark.sql.delta.catalog.DeltaCatalog \
  --conf spark.aifn.hunyuan.api_key=$HUNYUAN_API_KEY
```

进入 spark-sql 提示符后：

```sql
-- 基础调用
SELECT ai_classify('这家店真不错', array('正面', '负面')) AS label;

-- DDL 注册
CREATE OR REPLACE AI FUNCTION my_classify(text STRING)
RETURNS STRING
USING MODEL 'hunyuan-pro'
WITH PROMPT '判断情感：{text}'
OPTIONS (router='cascade(small=hunyuan-lite, large=hunyuan-pro, threshold=0.85)');

SELECT my_classify('糟透了') AS sentiment;
```

EXPLAIN 应该看到 `AIInferenceExec` 物理算子，`Filter` 在它**下方**。

---

## 3. 启动后端 + 前端

```bash
# Term 1
cd ai-function-demo
source .venv/bin/activate
export HUNYUAN_API_KEY=sk-xxx
export SPARK_HOME=$(pwd)/spark-dist/spark-3.5.8-bin-hadoop3
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload \
        --app-dir backend

# Term 2
cd ai-function-demo/frontend
npm run dev                              # 默认 http://localhost:5173
```

访问 `http://localhost:5173`，4 个 Tab：

- **Workbench**：写 SQL → 看结果 → EXPLAIN
- **Functions**：注册 AI Function（页面表单 / 直接 SQL）
- **Monitor**：实时 token / qps / 路由分布
- **Recovery**：查 hash 缓存、清缓存、Flush 到 Delta、Load 回缓存

---

## 4. 4 个验收场景

| # | 场景 | 操作 | 期望 |
|---|------|------|------|
| 1 | 基础调用 | Workbench 跑 `SELECT ai_classify(text, array('正面','负面')) FROM reviews LIMIT 5` | 5 行结果 + Monitor 看到 token 增长 |
| 2 | 谓词下推 | `SELECT ai_classify(...) FROM reviews WHERE country='US' AND score>4`，点 EXPLAIN | 物理计划：`Filter(country=US AND score>4)` 在 `AIInferenceExec` **下方** |
| 3 | 智能路由 | Functions 注册 cascade router → 跑 200 行 | Monitor 饼图 small_only ≈ 70%、upgraded ≈ 30% |
| 4 | 行级恢复 | 清缓存 → 跑 → token 增；再跑 → token 不变；Flush → 重启 → Load → 仍命中 | 第二次 token 不增；重启后 hash 仍命中 |

---

## 5. 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `mvn` 找不到 | 未装 Maven | `brew install maven` |
| 编译报 `target jvm-17` 不识别 | JDK 版本不对 | `export JAVA_HOME=$(/usr/libexec/java_home -v 17)` |
| 启动报 `ClassNotFoundException: AIFunctionExtension` | jar 路径错或 spark.jars 没配 | 检查 `$AIFN_JAR` 绝对路径 |
| `okhttp3` `NoSuchMethodError` | shade 失败，与 Spark 自带 okhttp 冲突 | 重新 `mvn clean package`，确认 shade-plugin 跑了 |
| Delta MERGE 报 catalog 错 | 缺 DeltaCatalog 配置 | 加 `--conf spark.sql.catalog.spark_catalog=org.apache.spark.sql.delta.catalog.DeltaCatalog` |
| 混元 401 | API Key 错 | `echo $HUNYUAN_API_KEY` 检查 |
| 前端跨域 | uvicorn 没开 cors | 已默认开 `*`，若收紧改 `app/main.py` |

---

## 6. 项目布局速查

```
ai-function-demo/
├── spark-dist/spark-3.5.8-bin-hadoop3/   ← 内置 Spark（无需另装）
├── spark-extension/
│   ├── pom.xml                            ← Maven 配置（spark.version=3.5.8）
│   ├── src/main/antlr4/.../AIFunctionDdl.g4   ← ANTLR4 grammar
│   ├── src/main/scala/.../aifn/           ← 17 个 Scala 源文件
│   └── src/test/scala/.../                ← 3 个测试 Suite
├── backend/                                ← FastAPI + PySpark
│   └── app/
│       ├── spark/session.py                ← 加载 jar + 注入 extensions
│       └── api/{sql,functions,metrics,recovery}.py
├── frontend/                               ← React + Vite + Monaco + ECharts
└── scripts/{build.sh, start.sh}            ← 一键编译与启动
```

# Spark Extension 子工程

修改 Spark 内核（通过 SparkSessionExtensions 机制）实现 AI Function。

## 目录结构

```
spark-extension/
├── pom.xml
└── src/main/scala/org/apache/spark/sql/aifn/
    ├── AIFunctionExtension.scala          # SparkSessionExtensions 入口
    ├── logical/AIInference.scala          # 自定义 LogicalPlan 节点
    ├── expressions/
    │   ├── AIComplete.scala               # ai_complete(prompt) 表达式
    │   ├── AIClassify.scala               # ai_classify(text, ARRAY<STRING>)
    │   └── AIExtract.scala                # ai_extract(text, schema_json)
    ├── physical/AIInferenceExec.scala     # 物理算子（独立 SparkPlan）
    ├── strategy/AIInferenceStrategy.scala # Logical → Physical
    ├── optimizer/
    │   ├── PushDownPredicateThroughAI.scala   # 谓词下推
    │   ├── MergeAIInvocations.scala            # 同行多调用合并
    │   └── AICostModel.scala                   # 成本模型
    ├── parser/AIFunctionParser.scala       # CREATE AI FUNCTION DDL
    ├── registry/
    │   ├── AIFunctionRegistry.scala        # 内置函数注入
    │   └── UserDefinedAIFunctions.scala    # DDL 注册的用户函数
    └── runtime/
        ├── HunyuanClient.scala             # 混元 OpenAI 兼容入口
        ├── DynamicBatcher.scala            # 动态批处理
        ├── ModelRouter.scala               # 自适应级联路由
        ├── StateTable.scala                # 行级幂等状态
        └── Governance.scala                # Token / QPS 配额
```

## 编译

```bash
cd spark-extension
mvn package -DskipTests
# 产物：target/aifn-spark-extension-0.1.0.jar
```

## 启用方式

启动 Spark 时（`spark-submit` 或 `pyspark` 或 SparkSession.builder）：

```bash
--jars target/aifn-spark-extension-0.1.0.jar
--conf spark.sql.extensions=org.apache.spark.sql.aifn.AIFunctionExtension
```

或在 Python 里：

```python
spark = (SparkSession.builder
    .config("spark.jars", "../spark-extension/target/aifn-spark-extension-0.1.0.jar")
    .config("spark.sql.extensions", "org.apache.spark.sql.aifn.AIFunctionExtension")
    .getOrCreate())
```

## 验证扩展生效

```sql
-- 1) 内置函数
SELECT ai_classify('物流超快', array('好评','差评'));

-- 2) DDL（Demo 用正则解析；生产建议改 ANTLR 注入）
CREATE AI FUNCTION review_tag(text STRING)
RETURNS STRING
USING MODEL 'cascade(small=hunyuan-lite, large=hunyuan-pro, threshold=0.85)'
WITH PROMPT '请用一个词标注这条评论的情感：{text}'
OPTIONS (batch_max_size='16');

-- 3) 物理计划应能看到 AIInferenceExec 节点
EXPLAIN FORMATTED
SELECT id, ai_classify(text, array('好评','差评'))
FROM reviews
WHERE country = 'US';
```

## 依赖

- JDK 17 / Scala 2.12.18 / Spark 3.5.1 / Delta 3.2.0
- okhttp 4.12 / jackson 2.17（已 shade 重定位避开 Spark 自带 okhttp 冲突）

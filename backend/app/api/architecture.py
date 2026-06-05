"""架构自描述：从 SparkSession 实时拉取扩展注入信息。

设计目的：让前端「技术原理讲解」页能展示**真实运行时数据**而非写死字符串：
  - spark.sql.extensions 配置值（证明扩展真的被启用）
  - spark.jars 含的 aifn jar 路径
  - 已注册的 AI 内置函数列表
  - 4 个 Catalyst 注入点（来自源码硬列表）
  - PushLimitBeforeAIInference 规则当前 enabled 状态

前端调用：GET /api/architecture
"""
from fastapi import APIRouter, Request

router = APIRouter()


# 4 个注入点 - 来自 AIFunctionExtension.scala，是源码事实
INJECTION_POINTS = [
    {
        "id": "parser",
        "name": "Parser",
        "method": "injectParser",
        "purpose": "扩展 SQL 语法：CREATE AI FUNCTION DDL",
        "spark_api": "SparkSessionExtensions.injectParser",
        "files": ["parser/AIFunctionParser.scala", "parser/AIFunctionDdl.g4"],
    },
    {
        "id": "optimizer",
        "name": "Optimizer Rules",
        "method": "injectOptimizerRule",
        "purpose": "Catalyst Optimizer 阶段注入 3 条规则",
        "spark_api": "SparkSessionExtensions.injectOptimizerRule",
        "files": [
            "optimizer/PushDownPredicateThroughAI.scala",
            "optimizer/MergeAIInvocations.scala",
            "optimizer/AICostModel.scala",
        ],
    },
    {
        "id": "posthoc",
        "name": "PostHoc Resolution",
        "method": "injectPostHocResolutionRule",
        "purpose": "Analyzer 之后、Optimizer 之前一次性下推 LocalLimit",
        "spark_api": "SparkSessionExtensions.injectPostHocResolutionRule",
        "files": ["optimizer/PushLimitBeforeAIInference.scala"],
    },
    {
        "id": "strategy",
        "name": "Planner Strategy",
        "method": "injectPlannerStrategy",
        "purpose": "把 AIInference 逻辑节点翻译为 AIInferenceExec 物理算子",
        "spark_api": "SparkSessionExtensions.injectPlannerStrategy",
        "files": ["strategy/AIInferenceStrategy.scala", "physical/AIInferenceExec.scala"],
    },
    {
        "id": "function",
        "name": "Function Registry",
        "method": "injectFunction",
        "purpose": "注册 ai_classify / ai_complete / ai_extract 内置函数",
        "spark_api": "SparkSessionExtensions.injectFunction",
        "files": [
            "expressions/AIClassify.scala",
            "expressions/AIComplete.scala",
            "expressions/AIExtract.scala",
            "registry/AIFunctionRegistry.scala",
        ],
    },
]


@router.get("")
def architecture(request: Request) -> dict:
    spark = request.app.state.spark
    sc = spark.sparkContext
    conf = sc.getConf()

    # 真实从 SparkConf 拉
    extensions_value = conf.get("spark.sql.extensions", "")
    jars_value = conf.get("spark.jars", "")
    aifn_jar = next(
        (j for j in jars_value.split(",") if "aifn-spark-extension" in j),
        None,
    )

    # 真实查 FunctionRegistry：3 个内置 AI 函数
    ai_functions = []
    for fn in ("ai_classify", "ai_complete", "ai_extract"):
        try:
            spark.sql(f"DESCRIBE FUNCTION {fn}")
            ai_functions.append({"name": fn, "registered": True})
        except Exception:
            ai_functions.append({"name": fn, "registered": False})

    # PushLimitBeforeAIInference 当前开关
    push_limit_enabled = spark.conf.get("spark.aifn.pushLimit.enabled", "true")

    return {
        "spark": {
            "version": spark.version,
            "master": conf.get("spark.master", ""),
            "app_id": sc.applicationId,
        },
        "extensions": {
            "configured": extensions_value,
            "aifn_loaded": "AIFunctionExtension" in extensions_value,
            "iceberg_loaded": "IcebergSparkSessionExtensions" in extensions_value,
        },
        "jar": {
            "path": aifn_jar,
            "loaded": aifn_jar is not None,
        },
        "ai_functions": ai_functions,
        "injection_points": INJECTION_POINTS,
        "rules": {
            "push_limit_enabled": push_limit_enabled,
        },
        # 项目代码统计（来自仓库）
        "stats": {
            "scala_files": 20,
            "scala_loc": 1736,
            "spark_source_modified": 0,  # 这是核心：零侵入
        },
    }

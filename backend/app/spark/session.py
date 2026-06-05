"""SparkSession 构建：加载 AI Function Catalyst 扩展 jar。

这是「修改 Spark 内核」对前端用户透明的接入点：
- spark.jars                 → 加载我们的扩展 jar
- spark.sql.extensions       → 注册 AIFunctionExtension + IcebergSparkSessionExtensions
- HUNYUAN_API_KEY/BASE_URL   → 通过环境变量传入 Executor，给 OpenAI 兼容客户端用
"""
from pyspark.sql import SparkSession
import os
import sys

from app.config import settings


def build_spark() -> SparkSession:
    # 透传到 driver 进程内的大模型 SDK
    os.environ["HUNYUAN_API_KEY"] = settings.HUNYUAN_API_KEY
    os.environ["HUNYUAN_BASE_URL"] = settings.HUNYUAN_BASE_URL
    os.environ["AIFN_DEMO_MODE"] = settings.AIFN_DEMO_MODE
    os.environ["AIFN_DEFAULT_SMALL_MODEL"] = settings.DEFAULT_SMALL_MODEL
    os.environ["AIFN_DEFAULT_LARGE_MODEL"] = settings.DEFAULT_LARGE_MODEL

    # 强制 PySpark worker 使用当前 venv 的 python
    py_exe = sys.executable
    os.environ["PYSPARK_PYTHON"] = py_exe
    os.environ["PYSPARK_DRIVER_PYTHON"] = py_exe

    # 把 Ivy 缓存重定向到工作区
    workspace = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    ivy_dir = os.path.join(workspace, ".ivy2")
    os.makedirs(ivy_dir, exist_ok=True)

    warehouse = os.path.abspath(settings.WAREHOUSE_PATH)
    os.makedirs(warehouse, exist_ok=True)

    builder = (
        SparkSession.builder.appName("AI-Function-Demo")
        .master(settings.SPARK_MASTER)
        .config("spark.jars", os.path.abspath(settings.AIFN_JAR_PATH))
        .config(
            "spark.sql.extensions",
            "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions,"
            "org.apache.spark.sql.aifn.AIFunctionExtension",
        )
        .config(
            "spark.jars.packages",
            "org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.6.1",
        )
        .config("spark.jars.ivy", ivy_dir)
        .config(
            "spark.sql.catalog.local",
            "org.apache.iceberg.spark.SparkCatalog",
        )
        .config("spark.sql.catalog.local.type", "hadoop")
        .config("spark.sql.catalog.local.warehouse", warehouse)
        .config("spark.sql.defaultCatalog", "local")
        .config("spark.sql.warehouse.dir", warehouse)
        .config("spark.sql.adaptive.enabled", "true")
        .config("spark.sql.shuffle.partitions", "8")
        # 把环境变量透传到 Executor
        .config("spark.executorEnv.HUNYUAN_API_KEY", settings.HUNYUAN_API_KEY)
        .config("spark.executorEnv.HUNYUAN_BASE_URL", settings.HUNYUAN_BASE_URL)
        .config("spark.executorEnv.AIFN_DEMO_MODE", settings.AIFN_DEMO_MODE)
        .config("spark.executorEnv.AIFN_DEFAULT_SMALL_MODEL", settings.DEFAULT_SMALL_MODEL)
        .config("spark.executorEnv.AIFN_DEFAULT_LARGE_MODEL", settings.DEFAULT_LARGE_MODEL)
    )
    spark = builder.getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    return spark

"""SparkSession 构建：加载 AI Function Catalyst 扩展 jar。

这是「修改 Spark 内核」对前端用户透明的接入点：
- spark.jars                 → 加载我们的扩展 jar
- spark.sql.extensions       → 注册 AIFunctionExtension + IcebergSparkSessionExtensions
- 腾讯云 SecretId/SecretKey  → 通过环境变量传入 Executor，给混元 V3 签名用
"""
from pyspark.sql import SparkSession
import os
import sys

from app.config import settings


def build_spark() -> SparkSession:
    # 透传到 driver 进程内的混元 SDK
    os.environ["TENCENT_SECRET_ID"] = settings.TENCENT_SECRET_ID
    os.environ["TENCENT_SECRET_KEY"] = settings.TENCENT_SECRET_KEY
    os.environ["HUNYUAN_HOST"] = settings.HUNYUAN_HOST
    os.environ["AIFN_DEMO_MODE"] = settings.AIFN_DEMO_MODE

    # 强制 PySpark worker 使用当前 venv 的 python（避免 driver=3.13 worker=3.14 错位）
    py_exe = sys.executable  # 当前进程 python，即 venv/bin/python
    os.environ["PYSPARK_PYTHON"] = py_exe
    os.environ["PYSPARK_DRIVER_PYTHON"] = py_exe

    # 把 Ivy 缓存重定向到工作区，避免 ~/.ivy2 在沙盒下不可写
    workspace = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    ivy_dir = os.path.join(workspace, ".ivy2")
    os.makedirs(ivy_dir, exist_ok=True)

    warehouse = os.path.abspath(settings.WAREHOUSE_PATH)
    os.makedirs(warehouse, exist_ok=True)

    builder = (
        SparkSession.builder.appName("AI-Function-Demo")
        .master(settings.SPARK_MASTER)
        # —— 加载我们自己写的 Catalyst 扩展 ——
        .config("spark.jars", os.path.abspath(settings.AIFN_JAR_PATH))
        .config(
            "spark.sql.extensions",
            "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions,"
            "org.apache.spark.sql.aifn.AIFunctionExtension",
        )
        # Iceberg：拉运行时
        .config(
            "spark.jars.packages",
            "org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.6.1",
        )
        .config("spark.jars.ivy", ivy_dir)
        # —— Iceberg 本地 catalog（hadoop 类型）——
        .config(
            "spark.sql.catalog.local",
            "org.apache.iceberg.spark.SparkCatalog",
        )
        .config("spark.sql.catalog.local.type", "hadoop")
        .config("spark.sql.catalog.local.warehouse", warehouse)
        .config("spark.sql.defaultCatalog", "local")
        # 仓库
        .config("spark.sql.warehouse.dir", warehouse)
        # AQE
        .config("spark.sql.adaptive.enabled", "true")
        .config("spark.sql.shuffle.partitions", "8")
        # 把环境变量透传到 Executor（V3 签名用）
        .config("spark.executorEnv.TENCENT_SECRET_ID", settings.TENCENT_SECRET_ID)
        .config("spark.executorEnv.TENCENT_SECRET_KEY", settings.TENCENT_SECRET_KEY)
        .config("spark.executorEnv.HUNYUAN_HOST", settings.HUNYUAN_HOST)
        .config("spark.executorEnv.AIFN_DEMO_MODE", settings.AIFN_DEMO_MODE)
    )
    spark = builder.getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    return spark

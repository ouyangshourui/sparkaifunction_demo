"""FastAPI 入口。"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import credentials as credentials_api
from app.api import functions as functions_api
from app.api import metrics as metrics_api
from app.api import recovery as recovery_api
from app.api import sql as sql_api
from app.api import architecture as architecture_api
from app.demo.seed import seed
from app.spark.session import build_spark


_spark = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _spark
    _spark = build_spark()
    # 记录 Spark UI URL（供前端导航栏链接使用）
    try:
        raw_url = _spark.sparkContext.uiWebUrl
        # 替换 host 为 127.0.0.1，确保浏览器能访问
        from urllib.parse import urlparse
        parsed = urlparse(raw_url)
        app.state.spark_ui_url = f"http://127.0.0.1:{parsed.port}"
    except Exception:
        app.state.spark_ui_url = "http://127.0.0.1:4040"  # fallback
    # 数据预热（Iceberg 默认 catalog=local）
    try:
        existing = [
            r["tableName"] for r in _spark.sql("SHOW TABLES IN local.default").collect()
        ]
    except Exception:
        existing = []
    if "reviews" not in existing:
        seed(_spark)
    else:
        # 已建库则切到该 namespace，让裸表名查询能命中
        _spark.sql("USE local.default")
    app.state.spark = _spark
    yield
    if _spark is not None:
        _spark.stop()


app = FastAPI(title="AI Function Demo Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5193", "http://127.0.0.1:5193"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sql_api.router, prefix="/api/sql", tags=["sql"])
app.include_router(functions_api.router, prefix="/api/functions", tags=["functions"])
app.include_router(metrics_api.router, prefix="/api/metrics", tags=["metrics"])
app.include_router(recovery_api.router, prefix="/api/recovery", tags=["recovery"])
app.include_router(credentials_api.router, prefix="/api/credentials", tags=["credentials"])
app.include_router(architecture_api.router, prefix="/api/architecture", tags=["architecture"])


@app.get("/api/health")
def health():
    return {"status": "ok", "spark_version": app.state.spark.version}


@app.get("/api/spark-ui-url")
def spark_ui_url():
    return {"url": app.state.spark_ui_url}

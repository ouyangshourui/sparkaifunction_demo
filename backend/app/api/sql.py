"""SQL 执行 + Plan 查询。"""
import time
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter()


class SqlRequest(BaseModel):
    sql: str
    limit: int = 100


@router.post("/execute")
def execute(req: SqlRequest, request: Request) -> dict[str, Any]:
    spark = request.app.state.spark
    t0 = time.monotonic()
    df = spark.sql(req.sql)
    rows = df.limit(req.limit).toPandas().to_dict(orient="records")
    elapsed = int((time.monotonic() - t0) * 1000)
    schema = [{"name": f.name, "type": f.dataType.simpleString()} for f in df.schema.fields]
    return {"rows": rows, "schema": schema, "elapsed_ms": elapsed, "row_count": len(rows)}


@router.post("/explain")
def explain(req: SqlRequest, request: Request) -> dict[str, str]:
    spark = request.app.state.spark
    df = spark.sql(req.sql)
    return {
        "plan": df._jdf.queryExecution().toString(),
    }

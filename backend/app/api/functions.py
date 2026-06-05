"""AI Function 管理：DDL 注册 / 列表 / 删除。"""
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter()


class CreateAIFnRequest(BaseModel):
    name: str
    params: list[dict]      # [{"col":"text","type":"STRING"}]
    return_type: str        # 例：STRING / STRUCT<...>
    model: str              # hy3-preview / cascade(...)
    prompt: str
    options: dict[str, str] = {}


@router.get("")
def list_functions(request: Request) -> list[dict[str, Any]]:
    spark = request.app.state.spark
    udfs = spark.sql("SHOW USER FUNCTIONS").collect()
    return [{"name": r[0]} for r in udfs]


@router.post("")
def create_function(req: CreateAIFnRequest, request: Request) -> dict[str, Any]:
    spark = request.app.state.spark
    params_sql = ", ".join(f"{p['col']} {p['type']}" for p in req.params)
    opts_sql = ", ".join(f"{k}='{v}'" for k, v in req.options.items())
    sql = (
        f"CREATE OR REPLACE AI FUNCTION {req.name}({params_sql}) "
        f"RETURNS {req.return_type} "
        f"USING MODEL '{req.model}' "
        f"WITH PROMPT '{req.prompt}'"
    )
    if opts_sql:
        sql += f" OPTIONS ({opts_sql})"
    spark.sql(sql)
    return {"ok": True, "ddl": sql}

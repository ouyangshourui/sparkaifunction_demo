"""指标接口：拉 JVM 端 Governance.snapshot()，并提供 SSE 推流。"""
import asyncio
import json

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

router = APIRouter()


def read_snapshot(spark) -> dict:
    """从 JVM 端 Governance 单例拉取统计。Py4J 调用 Scala object。"""
    try:
        gov_cls = spark._jvm.org.apache.spark.sql.aifn.runtime.Governance
        opt = gov_cls.instance()
        if opt.isEmpty():
            return {"total_tokens": 0, "calls_by_model": {}, "routed_distribution": {}}
        snap_jmap = opt.get().snapshot()
        # Scala Map → Java Map → Python dict
        data = json.loads(spark._jvm.scala.util.parsing.json.JSONObject(snap_jmap).toString())
        return data
    except Exception:
        # 回退：Spark UI 任务级指标（占位）
        return {"total_tokens": 0, "calls_by_model": {}, "routed_distribution": {}}


@router.get("")
def get_metrics(request: Request):
    spark = request.app.state.spark
    return read_snapshot(spark)


@router.get("/stream")
async def stream_metrics(request: Request):
    spark = request.app.state.spark

    async def event_gen():
        while True:
            if await request.is_disconnected():
                break
            data = read_snapshot(spark)
            yield {"event": "metrics", "data": json.dumps(data)}
            await asyncio.sleep(1.0)

    return EventSourceResponse(event_gen())

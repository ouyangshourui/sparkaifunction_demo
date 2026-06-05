"""指标接口：拉 JVM 端 Governance.snapshot()，并提供 SSE 推流。"""
import asyncio
import json
import logging

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

router = APIRouter()
log = logging.getLogger(__name__)

EMPTY = {
    "tokens_by_model": {},
    "prompt_tokens_by_model": {},
    "completion_tokens_by_model": {},
    "calls_by_model": {},
    "latency_ms_by_model": {},
    "routed_distribution": {},
    "total_tokens": 0,
    "total_prompt_tokens": 0,
    "total_completion_tokens": 0,
    "total_calls": 0,
    "total_latency_ms": 0,
    "avg_latency_ms": 0.0,
    "token_budget": 1_000_000,
    "qps_limit": 50,
    "budget_exhausted": False,
}


def read_snapshot(spark) -> dict:
    """从 JVM 端 Governance 单例拉取统计。Py4J 调用 Scala object。

    优先调用 snapshotJson() 拿到 JSON 字符串再 loads，避免 Scala Map 的桥接问题。
    """
    try:
        gov_cls = spark._jvm.org.apache.spark.sql.aifn.runtime.Governance
        opt = gov_cls.instance()
        if opt.isEmpty():
            return dict(EMPTY)
        gov = opt.get()
        # 优先 snapshotJson — JVM 侧用 Jackson 直接拼 JSON
        try:
            raw = gov.snapshotJson()
            data = json.loads(raw)
            return data
        except Exception as e:
            log.warning("snapshotJson failed, fallback to Java map: %s", e)
            jmap = gov.snapshotJava()
            data = {}
            it = jmap.entrySet().iterator()
            while it.hasNext():
                e = it.next()
                k = e.getKey()
                v = e.getValue()
                # 嵌套 Map 转 dict
                if hasattr(v, "entrySet"):
                    inner = {}
                    it2 = v.entrySet().iterator()
                    while it2.hasNext():
                        e2 = it2.next()
                        inner[e2.getKey()] = e2.getValue()
                    data[k] = inner
                else:
                    data[k] = v
            return data
    except Exception as e:
        log.exception("read_snapshot failed: %s", e)
        return dict(EMPTY)


@router.get("")
def get_metrics(request: Request):
    spark = request.app.state.spark
    return read_snapshot(spark)


@router.post("/reset")
def reset_metrics(request: Request):
    """清零指标计数器，方便演示重新跑。"""
    spark = request.app.state.spark
    try:
        gov_cls = spark._jvm.org.apache.spark.sql.aifn.runtime.Governance
        opt = gov_cls.instance()
        if not opt.isEmpty():
            opt.get().reset()
            return {"ok": True, "reset": True}
        return {"ok": True, "reset": False, "reason": "Governance not initialized yet"}
    except Exception as e:
        log.exception("reset_metrics failed")
        return {"ok": False, "error": str(e)}


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

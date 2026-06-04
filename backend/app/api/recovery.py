"""行级失败恢复：Replay 失败行，命中 hash 不重复扣费。"""
from fastapi import APIRouter, Request

router = APIRouter()


@router.post("/replay")
def replay(request: Request) -> dict:
    """重新跑当前 session 中失败的行。
    Demo 简化：让用户重新提交失败的 SQL；命中 prompt_hash 的会跳过。
    """
    return {
        "ok": True,
        "message": "请在 Workbench 重新提交相同的 SQL；命中 hash 的将跳过。",
    }


@router.get("/state")
def list_state(request: Request) -> dict:
    """列出 StateTable 内存缓存（Recovery 面板展示）。"""
    spark = request.app.state.spark
    try:
        st_cls = spark._jvm.org.apache.spark.sql.aifn.runtime.StateTable
        jmap = st_cls.listCache()
        # 取前 20 条 (key, value) 展示
        sample = []
        it = jmap.entrySet().iterator()
        while it.hasNext() and len(sample) < 20:
            e = it.next()
            sample.append(
                {"hash": str(e.getKey())[:16] + "…", "preview": str(e.getValue())[:80]}
            )
        return {"cached_count": int(jmap.size()), "sample": sample}
    except Exception as e:
        return {"cached_count": 0, "error": str(e)}


@router.post("/clear")
def clear_state(request: Request) -> dict:
    spark = request.app.state.spark
    st_cls = spark._jvm.org.apache.spark.sql.aifn.runtime.StateTable
    n = st_cls.clearCache()
    return {"cleared": int(n)}


@router.post("/flush-delta")
def flush_delta(request: Request) -> dict:
    """把当前批的 audit 条目以 MERGE INTO 形式落到 Iceberg 表 ai_inference_state。
    可在 Workbench 通过 SELECT * FROM ai_inference_state 查询持久化结果。
    """
    spark = request.app.state.spark
    st_cls = spark._jvm.org.apache.spark.sql.aifn.runtime.StateTable
    try:
        n = st_cls.flushToDelta(
            spark._jsparkSession, "local.default.ai_inference_state", ""
        )
        return {"flushed": int(n), "table": "ai_inference_state"}
    except Exception as e:
        return {"flushed": 0, "error": str(e)}


@router.post("/load-delta")
def load_delta(request: Request) -> dict:
    """启动后调用：把 Iceberg 表内容反向加载进进程缓存，演示『重启 Replay 仍命中』。"""
    spark = request.app.state.spark
    st_cls = spark._jvm.org.apache.spark.sql.aifn.runtime.StateTable
    try:
        n = st_cls.loadFromDelta(spark._jsparkSession, "local.default.ai_inference_state")
        return {"loaded": int(n)}
    except Exception as e:
        return {"loaded": 0, "error": str(e)}

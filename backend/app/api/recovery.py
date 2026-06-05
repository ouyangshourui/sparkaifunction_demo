"""行级失败恢复 API。

依托 spark-extension 中的 `org.apache.spark.sql.aifn.runtime.StateTable`：
  - cache:  ConcurrentHashMap<prompt_hash, output> (Executor 端)
  - audit:  ConcurrentLinkedQueue<AuditEntry>      (待 flush 到 Iceberg)
  - persist: Iceberg 表 `local.default.ai_inference_state`

API 一览：
  GET  /api/recovery/state         查 cache + audit_pending + 持久化样例
  POST /api/recovery/clear         清空进程内 cache
  POST /api/recovery/flush-delta   把 audit 以 MERGE INTO 落到 Iceberg
  POST /api/recovery/load-delta    从 Iceberg 反向加载到 cache
  POST /api/recovery/replay        Flush + Load 一键回放（演示重启 Replay）
"""
from fastapi import APIRouter, Request, HTTPException

router = APIRouter()

_TABLE = "local.default.ai_inference_state"


def _state_cls(spark):
    return spark._jvm.org.apache.spark.sql.aifn.runtime.StateTable


@router.get("/state")
def list_state(request: Request) -> dict:
    """列出 StateTable 进程内缓存 + 待 flush audit 数 + Iceberg 持久化总数。"""
    spark = request.app.state.spark
    try:
        st = _state_cls(spark)
        jmap = st.listCache()
        sample = []
        it = jmap.entrySet().iterator()
        while it.hasNext() and len(sample) < 20:
            e = it.next()
            v = str(e.getValue())
            sample.append({
                "hash": str(e.getKey())[:16] + "…",
                "preview": (v[:80] + "…") if len(v) > 80 else v,
            })
        cached = int(jmap.size())
        pending = int(st.auditPendingCount())

        # 顺手查一下 Iceberg 持久化条数（演示重启幂等）
        persisted = 0
        try:
            jspark = spark._jsparkSession
            if jspark.catalog().tableExists(_TABLE):
                df = spark.sql(f"SELECT COUNT(*) AS c FROM {_TABLE}")
                persisted = int(df.collect()[0][0])
        except Exception:
            persisted = -1  # 表不存在或暂不可读

        return {
            "cached_count": cached,
            "audit_pending": pending,
            "persisted_count": persisted,
            "table": _TABLE,
            "sample": sample,
        }
    except Exception as e:
        return {
            "cached_count": 0,
            "audit_pending": 0,
            "persisted_count": 0,
            "table": _TABLE,
            "sample": [],
            "error": str(e),
        }


@router.post("/clear")
def clear_state(request: Request) -> dict:
    """清空进程内缓存（演示『关闭命中再 Replay』）。"""
    spark = request.app.state.spark
    n = _state_cls(spark).clearCache()
    return {"cleared": int(n)}


@router.post("/flush-delta")
def flush_delta(request: Request) -> dict:
    """把当前批的 audit 条目以 MERGE INTO 形式落到 Iceberg。"""
    spark = request.app.state.spark
    try:
        n = _state_cls(spark).flushToDelta(spark._jsparkSession, _TABLE, "")
        return {"flushed": int(n), "table": _TABLE}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"flush failed: {e}")


@router.post("/load-delta")
def load_delta(request: Request) -> dict:
    """从 Iceberg 反向加载到 cache（演示『重启 Replay 仍命中』）。"""
    spark = request.app.state.spark
    try:
        n = _state_cls(spark).loadFromDelta(spark._jsparkSession, _TABLE)
        return {"loaded": int(n), "table": _TABLE}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"load failed: {e}")


@router.post("/replay")
def replay(request: Request) -> dict:
    """一键回放：清空 cache → load-delta → 重新可命中之前的 prompt_hash。

    场景：模拟重启或 cache 丢失后，从持久化 Iceberg 表重新建立幂等。
    """
    spark = request.app.state.spark
    try:
        st = _state_cls(spark)
        before = int(st.listCache().size())
        # 1. 把当前 audit 落盘（确保最新成果可被 Replay）
        flushed = int(st.flushToDelta(spark._jsparkSession, _TABLE, ""))
        # 2. 清空进程缓存
        cleared = int(st.clearCache())
        # 3. 从 Iceberg 反加载
        loaded = int(st.loadFromDelta(spark._jsparkSession, _TABLE))
        return {
            "ok": True,
            "before": before,
            "flushed": flushed,
            "cleared": cleared,
            "loaded": loaded,
            "message": (
                f"Replay 完成：flush {flushed} 条 audit → 清空 {cleared} 条 cache "
                f"→ 从 Iceberg 重新加载 {loaded} 条 prompt_hash"
            ),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"replay failed: {e}")

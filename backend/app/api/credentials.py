"""凭证管理 API：动态修改 OpenAI 兼容大模型 ApiKey/BaseUrl 并即时生效。

仅需一个 ApiKey + base_url，鉴权方式为 Authorization: Bearer ${api_key}。
默认 base_url 指向腾讯混元 OpenAI 兼容端点；也可换成 TokenHub / DeepSeek / OpenAI 等。

- GET  /api/credentials              返回当前凭证（ApiKey 半掩码）
- PUT  /api/credentials               写入新凭证 → 落 .env + 更新 os.environ + 重启 Spark
- POST /api/credentials/test          用当前请求体里的凭证发起一次真实调用，返回响应
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.config import settings
from app.models_catalog import CATALOG, normalize, to_dict

router = APIRouter()

ENV_PATH = Path(__file__).resolve().parents[2] / ".env"


# ---------- Schemas ----------
class CredentialsView(BaseModel):
    api_key_masked: str
    api_key_set: bool
    base_url: str
    small_model: str
    large_model: str
    demo_mode: str
    configured: bool


class CredentialsPayload(BaseModel):
    api_key: str = Field(..., description="OpenAI 兼容 ApiKey（Bearer Token）")
    base_url: str = Field(
        "https://tokenhub.tencentmaas.com/v1",
        description="OpenAI 兼容 base_url，例如腾讯云 TokenHub: https://tokenhub.tencentmaas.com/v1",
    )
    small_model: str = Field("hy-mt2-pro", description="小模型 id（网关接受小写连字符形式）")
    large_model: str = Field("hy3-preview", description="大模型 id（网关接受小写连字符形式）")
    demo_mode: str = Field("auto", description="auto / true / false")


class TestResponse(BaseModel):
    ok: bool
    request_id: Optional[str] = None
    text: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    elapsed_ms: int
    raw: Optional[dict] = None


# ---------- Helpers ----------
def _mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return value[:4] + "*" * (len(value) - 8) + value[-4:]


def _write_env_file(updates: dict[str, str]) -> None:
    """Merge updates into .env, preserving comments / order."""
    lines: list[str] = []
    seen: set[str] = set()
    if ENV_PATH.exists():
        for raw in ENV_PATH.read_text(encoding="utf-8").splitlines():
            stripped = raw.strip()
            if (
                not stripped
                or stripped.startswith("#")
                or "=" not in stripped
            ):
                lines.append(raw)
                continue
            k, _, _v = stripped.partition("=")
            k = k.strip()
            if k in updates:
                lines.append(f"{k}={updates[k]}")
                seen.add(k)
            else:
                lines.append(raw)
    for k, v in updates.items():
        if k not in seen:
            lines.append(f"{k}={v}")
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _normalize_base(url: str) -> str:
    u = (url or "").strip()
    return u[:-1] if u.endswith("/") else u


# ---------- Routes ----------
@router.get("/models")
def get_models() -> dict:
    """模型目录：友好名 ↔ 网关 ID 映射，给前端 Settings 渲染下拉/标签用。"""
    return {
        "models": [to_dict(m) for m in CATALOG],
        "defaults": {
            "small": settings.DEFAULT_SMALL_MODEL,
            "large": settings.DEFAULT_LARGE_MODEL,
        },
    }


@router.get("", response_model=CredentialsView)
def get_credentials() -> CredentialsView:
    key = settings.HUNYUAN_API_KEY or ""
    return CredentialsView(
        api_key_masked=_mask(key),
        api_key_set=bool(key),
        base_url=settings.HUNYUAN_BASE_URL,
        small_model=settings.DEFAULT_SMALL_MODEL,
        large_model=settings.DEFAULT_LARGE_MODEL,
        demo_mode=settings.AIFN_DEMO_MODE,
        configured=bool(key),
    )


@router.put("")
def put_credentials(payload: CredentialsPayload, request: Request) -> dict:
    """落 .env + 更新 settings + 更新 os.environ + 重启 Spark 让 executorEnv 生效。"""
    base_url = _normalize_base(payload.base_url)
    # 用户可能写 Hy3 preview / Hy-MT2-Pro 友好名 → 规范成网关 id
    small_id = normalize(payload.small_model, default="hy-mt2-pro")
    large_id = normalize(payload.large_model, default="hy3-preview")
    updates = {
        "HUNYUAN_API_KEY": payload.api_key,
        "HUNYUAN_BASE_URL": base_url,
        "DEFAULT_SMALL_MODEL": small_id,
        "DEFAULT_LARGE_MODEL": large_id,
        "AIFN_DEMO_MODE": payload.demo_mode,
    }
    _write_env_file(updates)

    # 更新进程内 settings
    settings.HUNYUAN_API_KEY = payload.api_key
    settings.HUNYUAN_BASE_URL = base_url
    settings.DEFAULT_SMALL_MODEL = small_id
    settings.DEFAULT_LARGE_MODEL = large_id
    settings.AIFN_DEMO_MODE = payload.demo_mode

    # 同步 os.environ（driver 进程立即生效；executor 在 local 模式同进程也能看到）
    os.environ["HUNYUAN_API_KEY"] = payload.api_key
    os.environ["HUNYUAN_BASE_URL"] = base_url
    os.environ["AIFN_DEMO_MODE"] = payload.demo_mode

    # 重启 Spark 让 executorEnv 重新带上新凭证
    restarted = False
    try:
        from app.spark.session import build_spark

        old = getattr(request.app.state, "spark", None)
        if old is not None:
            try:
                old.stop()
            except Exception:
                pass
        new_spark = build_spark()
        try:
            new_spark.sql("USE local.default")
        except Exception:
            pass
        request.app.state.spark = new_spark
        restarted = True
    except Exception as e:
        return {"ok": True, "saved": True, "spark_restarted": False, "warn": str(e)}

    return {
        "ok": True,
        "saved": True,
        "spark_restarted": restarted,
        "configured": bool(payload.api_key),
    }


@router.post("/test", response_model=TestResponse)
def test_credentials(payload: CredentialsPayload) -> TestResponse:
    """用当前请求体凭证直接走 OpenAI 兼容协议调一次 chat/completions。"""
    base_url = _normalize_base(payload.base_url)
    body = {
        "model": normalize(payload.small_model, default="hy-mt2-pro"),
        "messages": [
            {"role": "user", "content": "请用一句话回复：你好，混元。"}
        ],
        "stream": False,
        "temperature": 0.0,
    }
    payload_str = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    headers = {
        "Authorization": f"Bearer {payload.api_key}",
        "Content-Type": "application/json; charset=utf-8",
    }
    url = f"{base_url}/chat/completions"

    t0 = time.perf_counter()
    try:
        with httpx.Client(timeout=30.0) as cli:
            r = cli.post(url, headers=headers, content=payload_str.encode("utf-8"))
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        # 透传 OpenAI 风格 request id（可能在 header 或 body）
        req_id = r.headers.get("x-request-id") or r.headers.get("X-Request-Id")
        try:
            data = r.json()
        except Exception:
            return TestResponse(
                ok=False,
                request_id=req_id,
                error_code=f"HTTP_{r.status_code}",
                error_message=r.text[:500],
                elapsed_ms=elapsed_ms,
            )
        # OpenAI 风格错误结构
        if isinstance(data, dict) and isinstance(data.get("error"), dict):
            err = data["error"]
            return TestResponse(
                ok=False,
                request_id=data.get("id") or req_id,
                error_code=err.get("code") or err.get("type") or f"HTTP_{r.status_code}",
                error_message=err.get("message"),
                elapsed_ms=elapsed_ms,
                raw=data,
            )
        if not r.is_success:
            return TestResponse(
                ok=False,
                request_id=req_id,
                error_code=f"HTTP_{r.status_code}",
                error_message=str(data)[:500],
                elapsed_ms=elapsed_ms,
                raw=data if isinstance(data, dict) else None,
            )
        choices = data.get("choices") or []
        text = ""
        if choices:
            text = (choices[0].get("message") or {}).get("content", "")
        return TestResponse(
            ok=True,
            request_id=data.get("id") or req_id,
            text=text or "(empty)",
            elapsed_ms=elapsed_ms,
            raw=data,
        )
    except Exception as e:
        return TestResponse(
            ok=False,
            error_code="EXCEPTION",
            error_message=str(e),
            elapsed_ms=int((time.perf_counter() - t0) * 1000),
        )

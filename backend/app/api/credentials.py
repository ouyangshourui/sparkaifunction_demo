"""凭证管理 API：动态修改腾讯云混元 SecretId/SecretKey 并即时生效。

- GET  /api/credentials              返回当前凭证（SecretId 半掩码，SecretKey 仅返回是否已设置）
- PUT  /api/credentials               写入新凭证 → 落 .env + 更新 os.environ + 重启 Spark
- POST /api/credentials/test          用当前请求体里的凭证发起一次真实混元调用，返回响应
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.config import settings

router = APIRouter()

ENV_PATH = Path(__file__).resolve().parents[2] / ".env"


# ---------- Schemas ----------
class CredentialsView(BaseModel):
    secret_id_masked: str
    secret_key_set: bool
    hunyuan_host: str
    small_model: str
    large_model: str
    demo_mode: str
    # 是否已配置真实凭证（前端显示绿/红）
    configured: bool


class CredentialsPayload(BaseModel):
    secret_id: str = Field(..., description="腾讯云 SecretId")
    secret_key: str = Field(..., description="腾讯云 SecretKey")
    hunyuan_host: str = Field("hunyuan.tencentcloudapi.com")
    small_model: str = Field("hunyuan-lite")
    large_model: str = Field("hunyuan-pro")
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


def _read_env_file() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    out: dict[str, str] = {}
    for raw in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


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


def _sign_v3(secret_id: str, secret_key: str, host: str, payload: str) -> tuple[dict, int]:
    """生成腾讯云 V3 TC3-HMAC-SHA256 签名所需 headers。"""
    service = "hunyuan"
    action = "ChatCompletions"
    version = "2023-09-01"
    algorithm = "TC3-HMAC-SHA256"
    timestamp = int(time.time())
    date = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")

    canonical_headers = (
        "content-type:application/json; charset=utf-8\n"
        f"host:{host}\n"
        f"x-tc-action:{action.lower()}\n"
    )
    signed_headers = "content-type;host;x-tc-action"
    hashed_payload = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    canonical_request = "\n".join(
        ["POST", "/", "", canonical_headers, signed_headers, hashed_payload]
    )

    credential_scope = f"{date}/{service}/tc3_request"
    hashed_canonical = hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
    string_to_sign = f"{algorithm}\n{timestamp}\n{credential_scope}\n{hashed_canonical}"

    def _hmac(k: bytes, m: str) -> bytes:
        return hmac.new(k, m.encode("utf-8"), hashlib.sha256).digest()

    secret_date = _hmac(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _hmac(secret_date, service)
    secret_signing = _hmac(secret_service, "tc3_request")
    signature = hmac.new(
        secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    authorization = (
        f"{algorithm} Credential={secret_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return (
        {
            "Authorization": authorization,
            "Content-Type": "application/json; charset=utf-8",
            "Host": host,
            "X-TC-Action": action,
            "X-TC-Timestamp": str(timestamp),
            "X-TC-Version": version,
        },
        timestamp,
    )


# ---------- Routes ----------
@router.get("", response_model=CredentialsView)
def get_credentials() -> CredentialsView:
    sid = settings.TENCENT_SECRET_ID or ""
    skey = settings.TENCENT_SECRET_KEY or ""
    return CredentialsView(
        secret_id_masked=_mask(sid),
        secret_key_set=bool(skey),
        hunyuan_host=settings.HUNYUAN_HOST,
        small_model=settings.DEFAULT_SMALL_MODEL,
        large_model=settings.DEFAULT_LARGE_MODEL,
        demo_mode=settings.AIFN_DEMO_MODE,
        configured=bool(sid and skey),
    )


@router.put("")
def put_credentials(payload: CredentialsPayload, request: Request) -> dict:
    """落 .env + 更新 settings + 更新 os.environ + 重启 Spark 让 executorEnv 生效。"""
    updates = {
        "TENCENT_SECRET_ID": payload.secret_id,
        "TENCENT_SECRET_KEY": payload.secret_key,
        "HUNYUAN_HOST": payload.hunyuan_host,
        "DEFAULT_SMALL_MODEL": payload.small_model,
        "DEFAULT_LARGE_MODEL": payload.large_model,
        "AIFN_DEMO_MODE": payload.demo_mode,
    }
    _write_env_file(updates)

    # 更新进程内 settings
    settings.TENCENT_SECRET_ID = payload.secret_id
    settings.TENCENT_SECRET_KEY = payload.secret_key
    settings.HUNYUAN_HOST = payload.hunyuan_host
    settings.DEFAULT_SMALL_MODEL = payload.small_model
    settings.DEFAULT_LARGE_MODEL = payload.large_model
    settings.AIFN_DEMO_MODE = payload.demo_mode

    # 同步 os.environ（driver 进程立即生效；executor 在 local 模式同进程也能看到）
    os.environ["TENCENT_SECRET_ID"] = payload.secret_id
    os.environ["TENCENT_SECRET_KEY"] = payload.secret_key
    os.environ["HUNYUAN_HOST"] = payload.hunyuan_host
    os.environ["AIFN_DEMO_MODE"] = payload.demo_mode

    # 重启 Spark 让 executorEnv 重新带上新凭证（Iceberg 表会被自动重新发现）
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
        "configured": bool(payload.secret_id and payload.secret_key),
    }


@router.post("/test", response_model=TestResponse)
def test_credentials(payload: CredentialsPayload) -> TestResponse:
    """用当前请求体凭证直接调一次 hunyuan-lite。"""
    body = {
        "Model": payload.small_model or "hunyuan-lite",
        "Messages": [
            {
                "Role": "user",
                "Content": "请用一句话回复：你好，混元。",
            }
        ],
        "Stream": False,
        "Temperature": 0.0,
    }
    payload_str = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    headers, _ = _sign_v3(
        payload.secret_id, payload.secret_key, payload.hunyuan_host, payload_str
    )
    url = f"https://{payload.hunyuan_host}/"

    t0 = time.perf_counter()
    try:
        with httpx.Client(timeout=20.0) as cli:
            r = cli.post(url, headers=headers, content=payload_str.encode("utf-8"))
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        try:
            data = r.json()
        except Exception:
            return TestResponse(
                ok=False,
                error_code=f"HTTP_{r.status_code}",
                error_message=r.text[:500],
                elapsed_ms=elapsed_ms,
            )
        resp_obj = data.get("Response", {}) if isinstance(data, dict) else {}
        err = resp_obj.get("Error")
        if err:
            return TestResponse(
                ok=False,
                request_id=resp_obj.get("RequestId"),
                error_code=err.get("Code"),
                error_message=err.get("Message"),
                elapsed_ms=elapsed_ms,
                raw=data,
            )
        choices = resp_obj.get("Choices") or []
        text = ""
        if choices:
            text = (choices[0].get("Message") or {}).get("Content", "")
        return TestResponse(
            ok=True,
            request_id=resp_obj.get("RequestId"),
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

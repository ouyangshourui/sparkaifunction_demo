"""模型目录：友好名 ↔ 网关 ID 单一来源真相 (single source of truth)。

为什么需要：
- 用户/PM 想看到的展示名是 ``Hy3 Preview`` / ``Hy-MT2-Pro``。
- 网关（TokenHub / 腾讯混元 OpenAI 兼容端点）实际只识别 **小写连字符** 形式：
  ``hy3-preview`` / ``hy-mt2-pro`` ；带空格或驼峰会返回 ``400004 model not found``。
- 这份目录把两套表示绑定在一起，前端展示 ``label``，请求时发 ``id``，
  并提供 ``normalize()`` 把任何用户手写法（含空格 / 大小写 / 驼峰）规范化成网关 ID。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional


@dataclass(frozen=True)
class ModelInfo:
    id: str          # 网关识别的 model id（必须小写连字符）
    label: str       # UI 友好展示名
    size: str        # "small" | "large"
    desc: str        # 一句话用途说明
    aliases: tuple[str, ...] = ()  # 用户可能手写的旧字面量


CATALOG: tuple[ModelInfo, ...] = (
    ModelInfo(
        id="hy3-preview",
        label="Hy3 Preview",
        size="large",
        desc="大模型 · 复杂推理 / 结构化抽取 / cascade 升级路径",
        aliases=("Hy3 preview", "Hy3-preview", "hy3preview", "hunyuan-pro"),
    ),
    ModelInfo(
        id="hy-mt2-pro",
        label="Hy-MT2-Pro",
        size="small",
        desc="小模型 · 高 QPS 分类 / 短文本生成 / cascade 默认",
        aliases=("Hy-MT2-Pro", "hymt2pro", "hunyuan-lite"),
    ),
    ModelInfo(
        id="minimax-m3",
        label="MiniMax M3",
        size="small",
        desc="兜底备选小模型（同样走 OpenAI 兼容协议）",
    ),
)

_BY_ID: dict[str, ModelInfo] = {m.id: m for m in CATALOG}
_BY_KEY: dict[str, ModelInfo] = {}
for m in CATALOG:
    _BY_KEY[m.id.lower()] = m
    _BY_KEY[m.label.lower()] = m
    for a in m.aliases:
        _BY_KEY[a.lower()] = m


def normalize(name: Optional[str], default: str = "hy-mt2-pro") -> str:
    """把任意用户写法 → 规范的网关 model id。

    >>> normalize("Hy3 preview")
    'hy3-preview'
    >>> normalize("Hy-MT2-Pro")
    'hy-mt2-pro'
    >>> normalize("")
    'hy-mt2-pro'
    """
    if not name:
        return default
    key = name.strip().lower().replace("_", "-").replace(" ", "-")
    if key in _BY_KEY:
        return _BY_KEY[key].id
    # 也尝试不带连字符的紧凑形式
    compact = key.replace("-", "")
    for k, info in _BY_KEY.items():
        if k.replace("-", "") == compact:
            return info.id
    # 未识别就原样返回，让网关报错（便于发现新模型）
    return name.strip()


def label_of(model_id: str) -> str:
    info = _BY_ID.get(model_id)
    return info.label if info else model_id


def list_models(size: Optional[str] = None) -> Iterable[ModelInfo]:
    return tuple(m for m in CATALOG if size is None or m.size == size)


def to_dict(m: ModelInfo) -> dict:
    return {"id": m.id, "label": m.label, "size": m.size, "desc": m.desc}

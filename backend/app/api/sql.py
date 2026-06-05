"""SQL 执行 + Plan 查询。"""
import re
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


# ---------- EXPLAIN 树解析 ----------

_AI_NAMES = {"AIInferenceExec", "AIInference"}
_SCAN_HINT = ("BatchScan", "FileScan", "Scan", "RowDataSourceScan", "DataSourceV2Scan")
_LOGICAL_SCAN_HINT = ("DataSourceV2Relation", "LogicalRelation", "UnresolvedRelation", "Relation", "HiveTableRelation", "View")
_FILTER_HINT = ("Filter",)
_PROJECT_HINT = ("Project",)
_LIMIT_HINT = ("CollectLimit", "GlobalLimit", "LocalLimit", "TakeOrderedAndProject")

# AI 表达式名（出现在 simpleString 里以 `ai_xxx(...)` 形式）
_AI_FN_RE = re.compile(r"\b(ai_[a-z_]+)\s*\(", re.IGNORECASE)


def _category(name: str, simple: str = "") -> str:
    # 物理计划节点可能带 WholeStageCodegen 前缀如 "*(1) Filter"，去掉前缀再判断
    bare = re.sub(r"^\*\(\d+\)\s+", "", name).strip()
    if bare in _AI_NAMES or "AIInference" in bare:
        return "ai"
    # Project / Filter 等节点里 projectList 含 ai_xxx(...) 时，统一标为 "ai" 让图形侧高亮
    if simple and _AI_FN_RE.search(simple):
        for h in _PROJECT_HINT:
            if bare.startswith(h):
                return "ai"
    for h in _SCAN_HINT:
        if bare.startswith(h):
            return "scan"
    for h in _LOGICAL_SCAN_HINT:
        if bare.startswith(h):
            return "scan"
    for h in _FILTER_HINT:
        if bare.startswith(h):
            return "filter"
    for h in _PROJECT_HINT:
        if bare.startswith(h):
            return "project"
    for h in _LIMIT_HINT:
        if bare.startswith(h):
            return "limit"
    if "Exchange" in bare or "Shuffle" in bare:
        return "shuffle"
    return "other"


def _extract_ai_expressions(simple: str) -> list[str]:
    """从 simpleString 抽出 ai_xxx(...) 表达式（含括号内整段，最长 80 字）。"""
    out: list[str] = []
    for m in _AI_FN_RE.finditer(simple):
        start = m.start()
        # 找到完整匹配括号
        i = simple.find("(", start)
        if i < 0:
            continue
        depth = 0
        end = -1
        for j in range(i, len(simple)):
            ch = simple[j]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
        if end > 0:
            expr = simple[start:end]
            if len(expr) > 80:
                expr = expr[:77] + "..."
            out.append(expr)
    # 去重保序
    seen = set()
    dedup: list[str] = []
    for e in out:
        if e not in seen:
            seen.add(e)
            dedup.append(e)
    return dedup


def _extract_bracket_list(text: str, key: str) -> list[str] | None:
    """从 simpleString 里提取 `key: [a, b, c]` 列表（处理嵌套括号）。"""
    idx = text.find(key + ":")
    if idx < 0:
        idx = text.find(key + " :")
    if idx < 0:
        return None
    lb = text.find("[", idx)
    if lb < 0:
        return None
    depth = 0
    for i in range(lb, len(text)):
        ch = text[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                inner = text[lb + 1 : i].strip()
                if not inner:
                    return []
                # 用括号深度 split 顶层逗号
                parts: list[str] = []
                buf: list[str] = []
                d2 = 0
                for ch2 in inner:
                    if ch2 in "([{":
                        d2 += 1
                    elif ch2 in ")]}":
                        d2 -= 1
                    if ch2 == "," and d2 == 0:
                        parts.append("".join(buf).strip())
                        buf = []
                    else:
                        buf.append(ch2)
                if buf:
                    parts.append("".join(buf).strip())
                return [p for p in parts if p]
    return None


def _walk_plan(node, depth: int = 0, max_depth: int = 25) -> dict[str, Any] | None:
    if depth > max_depth or node is None:
        return None
    name = str(node.nodeName())
    try:
        simple = str(node.simpleString(180))
    except Exception:  # noqa: BLE001
        simple = name

    pushed = _extract_bracket_list(simple, "PushedFilters")
    runtime = _extract_bracket_list(simple, "RuntimeFilters")
    output = _extract_bracket_list(simple, "Output")

    # 提取扫描节点的表名（PushdownExec / BatchScan / FileScan）
    table = None
    m = re.search(r"BatchScan\s+([\w\.\-]+)", simple)
    if m:
        table = m.group(1)
    else:
        m = re.search(r"FileScan\s+\w+\s+([\w\.\-]+)", simple)
        if m:
            table = m.group(1)

    # Iceberg / V2 BatchScan 格式：[filters=a, b, c, groupedBy=...]
    if pushed is None and "filters=" in simple:
        fm = re.search(r"\[filters=([^\]]*?)(?:,\s*groupedBy=[^\]]*)?\]", simple)
        if fm:
            inner = fm.group(1).strip()
            if inner:
                # 用括号深度切顶层逗号
                parts: list[str] = []
                buf: list[str] = []
                d = 0
                for ch in inner:
                    if ch in "([{":
                        d += 1
                    elif ch in ")]}":
                        d -= 1
                    if ch == "," and d == 0:
                        parts.append("".join(buf).strip())
                        buf = []
                    else:
                        buf.append(ch)
                if buf:
                    parts.append("".join(buf).strip())
                pushed = [p for p in parts if p]
            else:
                pushed = []

    # RuntimeFilters: 解析裸 RuntimeFilters: [] 形式
    if runtime is None:
        rm = re.search(r"RuntimeFilters:\s*\[([^\]]*)\]", simple)
        if rm:
            inner = rm.group(1).strip()
            runtime = [x.strip() for x in inner.split(",") if x.strip()] if inner else []

    # Filter 节点的条件
    cond = None
    if name == "Filter":
        m2 = re.match(r"Filter\s+\((.+?)\)\s*$", simple)
        if m2:
            cond = m2.group(1)
        else:
            cond = simple[len("Filter"):].strip()

    # 收集 children
    children: list[dict[str, Any]] = []
    try:
        seq = node.children()
        size = int(seq.size())
        for i in range(size):
            c = seq.apply(i)
            walked = _walk_plan(c, depth + 1, max_depth)
            if walked is not None:
                children.append(walked)
    except Exception:  # noqa: BLE001
        pass

    ai_exprs = _extract_ai_expressions(simple)

    return {
        "name": name,
        "simple": simple,
        "category": _category(name, simple),
        "pushedFilters": pushed,
        "runtimeFilters": runtime,
        "output": output[:8] if output else None,
        "table": table,
        "condition": cond,
        "aiExpressions": ai_exprs or None,
        "children": children,
    }


def _split_plan_sections(plan_text: str) -> dict[str, str]:
    """把 qe.toString() 输出拆成 4 段。

    Spark 的格式固定为：
        == Parsed Logical Plan ==
        ...
        == Analyzed Logical Plan ==
        ...
        == Optimized Logical Plan ==
        ...
        == Physical Plan ==
        ...
    """
    sections = {"parsed": "", "analyzed": "", "optimized": "", "physical": ""}
    headers = [
        ("== Parsed Logical Plan ==", "parsed"),
        ("== Analyzed Logical Plan ==", "analyzed"),
        ("== Optimized Logical Plan ==", "optimized"),
        ("== Physical Plan ==", "physical"),
    ]
    # 找出每段起始位置
    positions: list[tuple[int, str]] = []
    for header, key in headers:
        idx = plan_text.find(header)
        if idx >= 0:
            positions.append((idx, key))
    positions.sort()
    for i, (idx, key) in enumerate(positions):
        end = positions[i + 1][0] if i + 1 < len(positions) else len(plan_text)
        # 跳过 header 行本身
        body_start = plan_text.find("\n", idx)
        if body_start < 0:
            continue
        sections[key] = plan_text[body_start + 1 : end].strip()
    return sections


@router.post("/explain")
def explain(req: SqlRequest, request: Request) -> dict[str, Any]:
    """返回 4 段 Plan + 三份解析树，让前端做"未下推 vs 下推后 vs 物理"三栏对比。

    返回字段：
      - plan / tree                : 全文 + executedPlan 物理树
      - plan_baseline / tree_baseline : "未下推视角"文本 (仅 Parsed 段) + analyzedPlan 树（兼容老字段）
      - plan_pushdown / tree_pushdown : "PostHoc 下推后"文本 (仅 Analyzed 段) + analyzedPlan 树【新增】
                                         此处展示规则刚下推完的快照；Spark Optimizer 主 batch 后续可能等价回退，
                                         但运行时 CollectLimit 仍会限流 AI 调用次数。
      - plan_optimized             : "已下推视角"文本 (Optimized + Physical)
      - sections                   : { parsed, analyzed, optimized, physical } 4 段拆分
      - diff                       : 关键差异摘要（pushedFilters / ai 位置 / 行数）
    """
    spark = request.app.state.spark
    df = spark.sql(req.sql)
    qe = df._jdf.queryExecution()
    plan_text = str(qe.toString())

    sections = _split_plan_sections(plan_text)

    # —— 三段文本拼装 ——
    # ① baseline = 真正"未下推"视角 → 只用 Parsed 段（用户原始 SQL 树，AI 函数还在 Project 顶层、LIMIT 还没动）
    plan_baseline_text = ""
    if sections["parsed"]:
        plan_baseline_text = "== Parsed Logical Plan ==\n" + sections["parsed"]
    plan_baseline_text = plan_baseline_text.strip()

    # ② pushdown = PostHoc Resolution 之后的形态 → 即 Analyzed 段【新增·关键】
    #    这是我们 PushLimitBeforeAIInference 规则刚下推完的快照，PM 在这里能直观看到
    #    LocalLimit 已经搬到 AI Project 之下、贴着 Scan/Filter。
    plan_pushdown_text = ""
    if sections["analyzed"]:
        plan_pushdown_text = "== Analyzed Logical Plan ==\n" + sections["analyzed"]
    plan_pushdown_text = plan_pushdown_text.strip()

    # ③ optimized = Spark 主 batch 优化 + Physical 物理形态
    plan_optimized_text = ""
    if sections["optimized"]:
        plan_optimized_text += "== Optimized Logical Plan ==\n" + sections["optimized"] + "\n\n"
    if sections["physical"]:
        plan_optimized_text += "== Physical Plan ==\n" + sections["physical"]
    plan_optimized_text = plan_optimized_text.strip()

    # —— 三份解析树 ——
    # 物理树（最终执行形态）
    try:
        executed = qe.executedPlan()
        tree = _walk_plan(executed)
    except Exception as exc:  # noqa: BLE001
        tree = {"name": "ParseFailed", "simple": str(exc), "category": "other", "children": []}

    # PostHoc 下推后的解析树（= analyzedPlan）
    tree_pushdown: dict[str, Any] | None = None
    try:
        analyzed = qe.analyzed()
        tree_pushdown = _walk_plan(analyzed)
    except Exception as exc:  # noqa: BLE001
        tree_pushdown = {
            "name": "ParseFailed",
            "simple": str(exc),
            "category": "other",
            "children": [],
        }

    # tree_baseline 保留对老前端的兼容（语义上等同 tree_pushdown，因为 Spark 不暴露 Parsed 阶段的可遍历树）
    tree_baseline = tree_pushdown

    # —— 差异摘要 ——
    def _find_scan(n: dict[str, Any] | None) -> dict[str, Any] | None:
        if not n:
            return None
        if n.get("category") == "scan":
            return n
        for c in n.get("children", []):
            r = _find_scan(c)
            if r:
                return r
        return None

    def _has_ai(simple: str) -> bool:
        return ("ai_classify" in simple) or ("ai_complete" in simple) or ("ai_extract" in simple)

    def _has_ai_node(n: dict[str, Any] | None) -> bool:
        if not n:
            return False
        if _has_ai(n.get("simple", "")):
            return True
        return any(_has_ai_node(c) for c in n.get("children", []))

    def _ai_position(root: dict[str, Any] | None, scan: dict[str, Any] | None) -> str:
        """判断 AI 函数所处位置（关键看 Scan 是否已下推过滤）：
        - Scan 有 pushedFilters → 行数过滤已在文件层完成 → above_scan
        - Scan 无 pushedFilters → 还需要内存 Filter 才过滤 → above_filter
        - 没找到 AI 节点 → unknown
        """
        if not _has_ai_node(root):
            return "unknown"
        if scan is not None:
            pushed = scan.get("pushedFilters")
            if pushed and len(pushed) > 0:
                return "above_scan"
        return "above_filter"

    opt_scan = _find_scan(tree)
    base_scan = _find_scan(tree_pushdown)

    # 判断 LocalLimit 在 AI Project 之下还是之上（验证规则是否生效）
    def _localimit_below_ai(n: dict[str, Any] | None) -> bool:
        """递归找 Project(ai_*) 节点，看其 child 链路里是否紧跟 LocalLimit。"""
        if not n:
            return False
        bare = re.sub(r"^\*\(\d+\)\s+", "", n.get("name", "")).strip()
        is_ai_project = (
            bare.startswith("Project")
            and n.get("category") == "ai"
        )
        if is_ai_project:
            for c in n.get("children", []):
                cn = re.sub(r"^\*\(\d+\)\s+", "", c.get("name", "")).strip()
                if cn.startswith("LocalLimit") or cn.startswith("GlobalLimit"):
                    return True
        for c in n.get("children", []):
            if _localimit_below_ai(c):
                return True
        return False

    diff = {
        "baseline_pushed_filters": base_scan.get("pushedFilters") if base_scan else None,
        "optimized_pushed_filters": opt_scan.get("pushedFilters") if opt_scan else None,
        "baseline_ai_position": _ai_position(tree_pushdown, base_scan),
        "optimized_ai_position": _ai_position(tree, opt_scan),
        "baseline_lines": len(plan_baseline_text.splitlines()),
        "pushdown_lines": len(plan_pushdown_text.splitlines()),
        "optimized_lines": len(plan_optimized_text.splitlines()),
        "limit_pushed_below_ai": _localimit_below_ai(tree_pushdown),
    }

    return {
        "plan": plan_text,
        "tree": tree,
        "plan_baseline": plan_baseline_text,
        "tree_baseline": tree_baseline,
        "plan_pushdown": plan_pushdown_text,
        "tree_pushdown": tree_pushdown,
        "plan_optimized": plan_optimized_text,
        "sections": sections,
        "diff": diff,
    }

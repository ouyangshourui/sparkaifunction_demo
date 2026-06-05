import { useEffect, useState } from "react";
import SqlEditor from "../components/SqlEditor";
import ResultTable from "../components/ResultTable";
import PlanTree from "../components/PlanTree";
import {
  executeSql,
  explainSql,
  getMetrics,
  resetMetrics,
  type ExplainResult,
  type PlanNode,
  type SqlResult,
} from "../api/client";
import { appendSegment, deriveLabel, diffSnapshot, emptyDelta, type SqlSegment } from "../lib/segments";

const SAMPLES: { title: string; sql: string }[] = [
  {
    title: "1. 情感分类",
    sql: `-- 直接调用内置 ai_classify\nSELECT id, text,\n       ai_classify(text, array('正面','负面','中性')) AS sentiment\nFROM reviews\nLIMIT 10;`,
  },
  {
    title: "2. 结构化抽取",
    sql: `SELECT id, content,\n       ai_extract(content, '{"intent":"string","priority":"string","need_human":"boolean"}') AS info\nFROM tickets\nLIMIT 8;`,
  },
  {
    title: "3. 谓词下推",
    sql: `-- 看 EXPLAIN：Filter(country=US, sales>1000) 推到 AIInferenceExec 之下\nSELECT id, text,\n       ai_classify(text, array('夸奖','投诉')) AS tag\nFROM reviews\nWHERE country = 'US' AND sales > 1000\nLIMIT 10;`,
  },
  {
    title: "4. 智能路由",
    sql: `-- DDL 注册带 cascade router 的 AI 函数\nCREATE OR REPLACE AI FUNCTION review_tag(text STRING)\nRETURNS STRING\nUSING MODEL 'cascade(small=hy-mt2-pro, large=hy3-preview, threshold=0.85)'\nWITH PROMPT '请用一个词标注情感：{text}'\nOPTIONS (batch_max_size='16');\n\nSELECT id, text, review_tag(text) AS tag\nFROM reviews\nLIMIT 20;`,
  },
];

/**
 * 对照样例：用同一份 reviews 表，两种写法对比 LIMIT 是否能穿透含 AI 的 Project。
 * 命中行 ~8 行，期望 A=8 次 AI 调用，B=3 次（节省 ~62%）。
 */
const COMPARE_PAIR = {
  title: "5. ⚡ LIMIT 下推对照（一键演示）",
  description: "同一段 SQL 两种写法，看 ai_classify 实际跑几次",
  a: {
    label: "原写法（LIMIT 在外层）",
    sql: `-- A：LIMIT 套在含 AI 的 SELECT 外面\n-- 没有 PushLimitBeforeAIInference 时，AI 会对所有命中过滤的行都跑\nSELECT id, text,\n       ai_classify(text, array('夸奖','投诉')) AS tag\nFROM reviews\nWHERE country = 'US' AND sales > 1000\nLIMIT 3;`,
  },
  b: {
    label: "子查询（LIMIT 紧贴 Filter）",
    sql: `-- B：先把 Filter+LIMIT 在子查询里截断，AI 只跑 3 行\nSELECT id, text,\n       ai_classify(text, array('夸奖','投诉')) AS tag\nFROM (\n  SELECT id, text\n  FROM reviews\n  WHERE country = 'US' AND sales > 1000\n  LIMIT 3\n) t;`,
  },
};

export default function Workbench() {
  const [sql, setSql] = useState(SAMPLES[0].sql);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [plan, setPlan] = useState<ExplainResult | null>(null);
  const [planTab, setPlanTab] = useState<"graph" | "text">("graph");
  // half: 半屏 | wide: 下半屏全宽 | full: 整页覆盖
  const [planView, setPlanView] = useState<"half" | "wide" | "full">("half");
  // 全屏下的对比模式：split=并排 / optimized=只看优化后 / baseline=只看原始
  const [compareMode, setCompareMode] = useState<"split" | "optimized" | "baseline" | "pushdown">("split");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  // 一键对照演示
  const [compareRunning, setCompareRunning] = useState(false);
  const [compareLog, setCompareLog] = useState<string[]>([]);
  const [compareResult, setCompareResult] = useState<{ a: SqlSegment; b: SqlSegment } | null>(null);

  // ESC 关闭全屏
  useEffect(() => {
    if (planView !== "full") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlanView("half");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [planView]);

  const run = async () => {
    setLoading(true);
    setErr("");
    setResult(null);
    try {
      // 跑前先取一次快照，跑完再取，差量记入"段记录"
      const before = await getMetrics().catch(() => ({}));
      const r = await executeSql(sql, 100);
      setResult(r);
      const after = await getMetrics().catch(() => before);
      const seg: SqlSegment = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        label: deriveLabel(sql),
        sql: sql.slice(0, 400),
        ok: true,
        elapsed_ms: r.elapsed_ms,
        row_count: r.row_count,
        ts: Date.now(),
        delta: diffSnapshot(before, after),
      };
      appendSegment(seg);
    } catch (e: any) {
      const detail = e.response?.data?.detail ?? e.message;
      setErr(detail);
      appendSegment({
        id: `${Date.now()}-err`,
        label: deriveLabel(sql),
        sql: sql.slice(0, 400),
        ok: false,
        err: detail,
        elapsed_ms: 0,
        row_count: 0,
        ts: Date.now(),
        delta: emptyDelta(),
      });
    } finally {
      setLoading(false);
    }
  };

  const showPlan = async () => {
    try {
      const p = await explainSql(sql);
      setPlan(p);
      setPlanTab("graph");
    } catch (e: any) {
      setErr(e.message);
    }
  };

  /** 一键对照：reset → 跑 A → 跑 B → 落两条段，groupId 相同。 */
  const runCompare = async () => {
    setCompareRunning(true);
    setCompareLog([]);
    setCompareResult(null);
    setErr("");
    const groupId = `cmp-${Date.now()}`;
    const log = (s: string) => setCompareLog((arr) => [...arr, s]);
    try {
      log("① 重置 Metrics 计数器…");
      await resetMetrics();

      log(`② 跑 A：${COMPARE_PAIR.a.label}`);
      setSql(COMPARE_PAIR.a.sql);
      const beforeA = await getMetrics().catch(() => ({}));
      const ra = await executeSql(COMPARE_PAIR.a.sql, 100);
      const afterA = await getMetrics().catch(() => beforeA);
      const segA: SqlSegment = {
        id: `${groupId}-a`,
        label: COMPARE_PAIR.a.label,
        sql: COMPARE_PAIR.a.sql,
        ok: true,
        elapsed_ms: ra.elapsed_ms,
        row_count: ra.row_count,
        ts: Date.now(),
        delta: diffSnapshot(beforeA, afterA),
        groupId,
      };
      appendSegment(segA);
      log(`   → ${ra.row_count} 行 / ${segA.delta.total_calls} 次 AI 调用 / ${segA.delta.total_tokens} tokens`);

      log(`③ 跑 B：${COMPARE_PAIR.b.label}`);
      setSql(COMPARE_PAIR.b.sql);
      const beforeB = await getMetrics().catch(() => afterA);
      const rb = await executeSql(COMPARE_PAIR.b.sql, 100);
      const afterB = await getMetrics().catch(() => beforeB);
      const segB: SqlSegment = {
        id: `${groupId}-b`,
        label: COMPARE_PAIR.b.label,
        sql: COMPARE_PAIR.b.sql,
        ok: true,
        elapsed_ms: rb.elapsed_ms,
        row_count: rb.row_count,
        ts: Date.now(),
        delta: diffSnapshot(beforeB, afterB),
        groupId,
      };
      appendSegment(segB);
      log(`   → ${rb.row_count} 行 / ${segB.delta.total_calls} 次 AI 调用 / ${segB.delta.total_tokens} tokens`);

      const saved =
        segA.delta.total_calls > 0
          ? Math.max(0, 1 - segB.delta.total_calls / segA.delta.total_calls) * 100
          : 0;
      log(`④ 完成 — 节省 AI 调用 ${saved.toFixed(1)}%（切到 Monitor 看完整对比卡）`);
      setCompareResult({ a: segA, b: segB });
      setResult(rb);
    } catch (e: any) {
      const msg = e.response?.data?.detail ?? e.message;
      log(`✗ 失败：${msg}`);
      setErr(msg);
    } finally {
      setCompareRunning(false);
    }
  };

  return (
    <div className="h-full grid grid-cols-12 gap-2 p-2">
      {/* 样例 */}
      <aside className="col-span-2 bg-bgPanel border border-border rounded p-2 overflow-auto">
        <div className="text-textSub text-xs uppercase mb-2">Samples</div>
        {SAMPLES.map((s) => (
          <button
            key={s.title}
            onClick={() => setSql(s.sql)}
            className="block w-full text-left px-2 py-1.5 mb-1 rounded hover:bg-bgPanel2 text-textMain text-sm"
          >
            {s.title}
          </button>
        ))}

        {/* 一键对照样例 */}
        <div className="mt-3 pt-3 border-t border-border">
          <div className="text-amber-400 text-xs font-semibold mb-1">{COMPARE_PAIR.title}</div>
          <div className="text-textSub text-[11px] mb-2 leading-tight">
            {COMPARE_PAIR.description}
          </div>
          <div className="flex gap-1 mb-1.5">
            <button
              onClick={() => setSql(COMPARE_PAIR.a.sql)}
              className="flex-1 px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 text-[11px] font-mono"
              title={COMPARE_PAIR.a.label}
            >
              A · 原写法
            </button>
            <button
              onClick={() => setSql(COMPARE_PAIR.b.sql)}
              className="flex-1 px-2 py-1 rounded bg-teal/20 hover:bg-teal/30 border border-teal/40 text-teal text-[11px] font-mono"
              title={COMPARE_PAIR.b.label}
            >
              B · 子查询
            </button>
          </div>
          <button
            onClick={runCompare}
            disabled={compareRunning}
            className="w-full px-2 py-1.5 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-white text-xs font-semibold"
          >
            {compareRunning ? "对照运行中…" : "▶▶ 一键对照运行"}
          </button>

          {/* 实时日志 */}
          {compareLog.length > 0 && (
            <div className="mt-2 bg-bgPanel2 border border-border rounded p-1.5 text-[10px] font-mono text-textSub max-h-32 overflow-auto">
              {compareLog.map((l, i) => (
                <div key={i} className="leading-tight">{l}</div>
              ))}
            </div>
          )}

          {/* 结果对比卡 */}
          {compareResult && <CompareCardMini pair={compareResult} />}
        </div>
      </aside>

      {/* 编辑器 + 结果 */}
      <section className="col-span-10 grid grid-rows-[40%_60%] gap-2">
        <div className="bg-bgPanel border border-border rounded overflow-hidden flex flex-col">
          <div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-bgPanel2">
            <button
              onClick={run}
              disabled={loading}
              className="px-3 py-1 rounded bg-teal hover:bg-tealDeep text-white text-xs font-semibold"
            >
              {loading ? "Running..." : "▶ 运行"}
            </button>
            <button
              onClick={showPlan}
              className="px-3 py-1 rounded bg-bgPanel border border-border hover:bg-bgPanel2 text-textMain text-xs"
            >
              EXPLAIN
            </button>
            {result && (
              <span className="text-textSub text-xs ml-auto">
                {result.row_count} rows · {result.elapsed_ms} ms
              </span>
            )}
          </div>
          <div className="flex-1">
            <SqlEditor value={sql} onChange={setSql} />
          </div>
        </div>

        <div className={`grid gap-2 ${planView === "wide" ? "grid-cols-1" : "grid-cols-2"}`}>
          {planView === "half" && (
            <div className="bg-bgPanel border border-border rounded overflow-hidden flex flex-col">
              <div className="px-3 py-1.5 text-xs uppercase text-textSub border-b border-border bg-bgPanel2">
                Result {err && <span className="text-red-400 ml-2">{err}</span>}
              </div>
              <ResultTable data={result} />
            </div>
          )}

          <div className="bg-bgPanel border border-border rounded overflow-hidden flex flex-col min-w-0">
            <div className="flex items-center gap-1 px-3 py-1 border-b border-border bg-bgPanel2 text-xs">
              <span className="uppercase text-textSub mr-2">Physical Plan</span>
              <button
                onClick={() => setPlanTab("graph")}
                className={`px-2 py-0.5 rounded ${
                  planTab === "graph"
                    ? "bg-teal text-white"
                    : "bg-bgPanel border border-border text-textSub hover:text-textMain"
                }`}
              >
                图形
              </button>
              <button
                onClick={() => setPlanTab("text")}
                className={`px-2 py-0.5 rounded ${
                  planTab === "text"
                    ? "bg-teal text-white"
                    : "bg-bgPanel border border-border text-textSub hover:text-textMain"
                }`}
              >
                文本
              </button>
              <div className="ml-auto flex gap-1">
                <button
                  onClick={() => setPlanView(planView === "wide" ? "half" : "wide")}
                  title="切换下半屏全宽"
                  className={`px-2 py-0.5 rounded border ${
                    planView === "wide"
                      ? "border-teal text-teal"
                      : "border-border text-textSub hover:text-textMain"
                  }`}
                >
                  {planView === "wide" ? "↹ 半屏" : "⤢ 全宽"}
                </button>
                <button
                  onClick={() => setPlanView("full")}
                  title="整页覆盖，最大化阅读"
                  className="px-2 py-0.5 rounded border border-border text-textSub hover:text-textMain"
                >
                  ⛶ 全屏
                </button>
              </div>
            </div>
            {planTab === "graph" ? (
              <PlanTree tree={plan?.tree ?? null} />
            ) : (
              <pre className="flex-1 overflow-auto p-3 text-xs text-textMain font-mono whitespace-pre-wrap break-words leading-relaxed">
                {plan?.plan || "点击 EXPLAIN 查看物理计划"}
              </pre>
            )}
          </div>
        </div>
      </section>

      {/* —— 整页覆盖：Baseline vs Optimized 并排对比 —— */}
      {planView === "full" && (
        <div className="fixed inset-0 z-50 bg-bgDark/95 backdrop-blur flex flex-col">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bgPanel">
            <span className="text-teal text-sm uppercase tracking-wider">
              Plan · 三阶段下推可视化 v2
            </span>
            <span className="text-[10px] text-textSub bg-bgPanel2 px-1.5 py-0.5 rounded font-mono">
              Parsed → PostHoc → Optimized
            </span>

            {/* 视图切换 */}
            <div className="ml-4 flex gap-1">
              <button
                onClick={() => setPlanTab("graph")}
                className={`px-2 py-0.5 rounded text-xs ${
                  planTab === "graph"
                    ? "bg-teal text-white"
                    : "bg-bgPanel border border-border text-textSub hover:text-textMain"
                }`}
              >
                图形
              </button>
              <button
                onClick={() => setPlanTab("text")}
                className={`px-2 py-0.5 rounded text-xs ${
                  planTab === "text"
                    ? "bg-teal text-white"
                    : "bg-bgPanel border border-border text-textSub hover:text-textMain"
                }`}
              >
                文本
              </button>
            </div>

            {/* 对比模式 */}
            <div className="ml-4 flex gap-1 items-center">
              <span className="text-textSub text-xs mr-1">对比：</span>
              <button
                onClick={() => setCompareMode("split")}
                className={`px-2 py-0.5 rounded text-xs ${
                  compareMode === "split"
                    ? "bg-amber-500 text-white"
                    : "bg-bgPanel border border-border text-textSub hover:text-textMain"
                }`}
              >
                ⇆ 三栏对比
              </button>
              <button
                onClick={() => setCompareMode("baseline")}
                className={`px-2 py-0.5 rounded text-xs ${
                  compareMode === "baseline"
                    ? "bg-rose-500 text-white"
                    : "bg-bgPanel border border-border text-textSub hover:text-textMain"
                }`}
              >
                ① 未下推
              </button>
              <button
                onClick={() => setCompareMode("pushdown")}
                className={`px-2 py-0.5 rounded text-xs ${
                  compareMode === "pushdown"
                    ? "bg-violet-600 text-white"
                    : "bg-bgPanel border border-border text-textSub hover:text-textMain"
                }`}
                title="PostHoc Resolution 之后、Optimizer 主 batch 之前 —— 我们规则刚下推完的快照"
              >
                ② 下推后形态
              </button>
              <button
                onClick={() => setCompareMode("optimized")}
                className={`px-2 py-0.5 rounded text-xs ${
                  compareMode === "optimized"
                    ? "bg-teal text-white"
                    : "bg-bgPanel border border-border text-textSub hover:text-textMain"
                }`}
              >
                ③ Optimizer 后
              </button>
            </div>

            <span className="text-textSub text-xs ml-2">按 ESC 关闭</span>
            <button
              onClick={() => setPlanView("half")}
              title="关闭全屏 (Esc)"
              className="ml-auto w-8 h-8 rounded bg-bgPanel border border-border text-textSub hover:text-red-400 hover:border-red-400 text-lg leading-none flex items-center justify-center"
            >
              ✕
            </button>
          </div>

          {/* 差异提示条 + 读图指南 */}
          {plan && (
            <>
              <div className="px-4 py-2 bg-violet-500/10 border-b border-violet-500/30 text-[11px] text-textSub leading-relaxed">
                <span className="text-violet-300 font-semibold">📖 读图指南：</span>
                <span className="text-rose-400 font-semibold">① 未下推</span> 是用户原始 SQL 的解析树（LIMIT 在 AI 之上）；
                <span className="text-violet-300 font-semibold mx-1">② PostHoc 下推后</span>是
                <span className="text-amber-300 font-mono"> PushLimitBeforeAIInference </span>
                规则刚生效的快照（<span className="text-emerald-400 font-mono">LocalLimit 已搬到 AI Project 之下</span>）；
                <span className="text-teal font-semibold">③ Optimizer + Physical</span>
                是 Spark 主 batch 的最终形态——
                <span className="text-orange-400 font-semibold">注意：Spark 内置 EliminateLimits/CombineLimits 等规则会在 fixed-point 内做等价折叠，把 LocalLimit 提回 Project 之上，但运行时 CollectLimit 仍在 driver 端限流，AI 函数最多只调用 LIMIT N 次（见 Monitor 实测）</span>
              </div>
              {compareMode === "split" && <PlanDiffSummary plan={plan} />}
            </>
          )}

          <div className="flex-1 overflow-hidden">
            {compareMode === "split" ? (
              <div className="grid grid-cols-3 h-full divide-x divide-border">
                <PlanPane
                  title="① ❌ Baseline · 未下推（Parsed）"
                  subtitle="用户原始 SQL：LIMIT 在 AI Project 之上 → 全表过 AI 后再砍 N 行"
                  tone="rose"
                  planTab={planTab}
                  text={plan?.plan_baseline || ""}
                  tree={null /* Spark 不暴露 Parsed 阶段可遍历树，仅展示文本 */}
                  highlight={[
                    "Filter",
                    "Project",
                    "ai_classify",
                    "ai_complete",
                    "ai_extract",
                    "UnresolvedRelation",
                    "GlobalLimit",
                  ]}
                />
                <PlanPane
                  title="② ✅ PostHoc 下推后（Analyzed · 规则生效形态）"
                  subtitle="PushLimitBeforeAIInference 已生效：LocalLimit 已搬到 AI Project 之下，AI 只看 LIMIT N 行"
                  tone="violet"
                  planTab={planTab}
                  text={plan?.plan_pushdown || plan?.plan_baseline || ""}
                  tree={plan?.tree_pushdown ?? plan?.tree_baseline ?? null}
                  highlight={[
                    "LocalLimit",
                    "GlobalLimit",
                    "Project",
                    "ai_classify",
                    "ai_complete",
                    "ai_extract",
                  ]}
                />
                <PlanPane
                  title="③ ⚠ Optimizer + Physical（最终执行形态）"
                  subtitle="Spark 主 batch 后；LocalLimit 可能被等价折叠回 Project 之上，但运行时 CollectLimit 仍限流 AI 调用"
                  tone="teal"
                  planTab={planTab}
                  text={plan?.plan_optimized || plan?.plan || ""}
                  tree={plan?.tree ?? null}
                  highlight={[
                    "PushedFilters",
                    "filters=",
                    "BatchScan",
                    "CollectLimit",
                    "ai_classify",
                    "ai_complete",
                    "ai_extract",
                  ]}
                />
              </div>
            ) : compareMode === "baseline" ? (
              <PlanPane
                title="① Baseline · 未下推（用户原始写法）"
                subtitle="Parsed Logical Plan：用户 SQL 的原始解析树"
                tone="rose"
                planTab={planTab}
                text={plan?.plan_baseline || ""}
                tree={null}
                fullHeight
                highlight={["Filter", "Project", "ai_classify", "UnresolvedRelation", "GlobalLimit"]}
              />
            ) : compareMode === "pushdown" ? (
              <PlanPane
                title="② PostHoc 下推后（规则生效形态）"
                subtitle="Analyzed Logical Plan：LocalLimit 已搬到 AI Project 之下，规则生效快照"
                tone="violet"
                planTab={planTab}
                text={plan?.plan_pushdown || plan?.plan_baseline || ""}
                tree={plan?.tree_pushdown ?? plan?.tree_baseline ?? null}
                fullHeight
                highlight={["LocalLimit", "GlobalLimit", "Project", "ai_classify"]}
              />
            ) : (
              <PlanPane
                title="③ Optimizer + Physical（最终执行形态）"
                subtitle="Optimized + Physical：CollectLimit 在 driver 端运行时限流 AI 调用次数"
                tone="teal"
                planTab={planTab}
                text={plan?.plan_optimized || plan?.plan || ""}
                tree={plan?.tree ?? null}
                fullHeight
                highlight={["PushedFilters", "filters=", "BatchScan", "CollectLimit", "ai_classify"]}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// —— 子组件：单侧 Plan 面板 ——
interface PlanPaneProps {
  title: string;
  subtitle: string;
  tone: "rose" | "teal" | "violet";
  planTab: "graph" | "text";
  text: string;
  tree: PlanNode | null;
  fullHeight?: boolean;
  /** 文本视图下需要高亮的关键字，命中行整行高亮 */
  highlight?: string[];
}

function PlanPane({ title, subtitle, tone, planTab, text, tree, highlight }: PlanPaneProps) {
  const accent =
    tone === "rose"
      ? "text-rose-400 border-rose-500/40"
      : tone === "violet"
      ? "text-violet-400 border-violet-500/40"
      : "text-teal border-teal/40";
  const headerColor =
    tone === "rose" ? "text-rose-400" : tone === "violet" ? "text-violet-400" : "text-teal";
  const lineHighlightBg =
    tone === "rose" ? "bg-rose-500/10" : tone === "violet" ? "bg-violet-500/10" : "bg-teal/10";
  const lineHighlightBorder =
    tone === "rose"
      ? "border-l-2 border-rose-500/60"
      : tone === "violet"
      ? "border-l-2 border-violet-500/60"
      : "border-l-2 border-teal/60";

  // 把一行里的关键字（含 ai_xxx 调用）渲染成行内高亮 span
  const renderLineWithInline = (line: string, _i: number) => {
    if (!line) return " ";
    // 拼一个 alternation 正则：highlight 列表 + ai_xxx(... 整段
    const tokens: { re: RegExp; cls: string }[] = [
      // ai_xxx(...) 整段：括号深度匹配，简化版用懒匹配 + 限定 80 字符
      { re: /\bai_[a-zA-Z_]+\([^()]*(?:\([^()]*\)[^()]*)*\)/g, cls: "bg-sky-500/30 text-sky-100 px-0.5 rounded" },
      { re: /\bPushedFilters\b|\bfilters=[^,\]]+/g, cls: "bg-emerald-500/25 text-emerald-100 px-0.5 rounded" },
      { re: /\bBatchScan\b|\bFileScan\b/g, cls: "bg-purple-500/25 text-purple-100 px-0.5 rounded" },
      { re: /\bGlobalLimit\b|\bLocalLimit\b|\bCollectLimit\b/g, cls: "bg-rose-500/25 text-rose-100 px-0.5 rounded" },
    ];

    type Seg = { s: number; e: number; cls: string; text: string };
    const segs: Seg[] = [];
    for (const t of tokens) {
      let m: RegExpExecArray | null;
      const re = new RegExp(t.re.source, t.re.flags);
      while ((m = re.exec(line)) !== null) {
        segs.push({ s: m.index, e: m.index + m[0].length, cls: t.cls, text: m[0] });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    if (segs.length === 0) return line;
    segs.sort((a, b) => a.s - b.s);
    // 去重叠：保留先出现且更长的
    const merged: Seg[] = [];
    for (const s of segs) {
      if (merged.length === 0 || s.s >= merged[merged.length - 1].e) merged.push(s);
    }
    const out: (string | JSX.Element)[] = [];
    let cursor = 0;
    merged.forEach((seg, idx) => {
      if (cursor < seg.s) out.push(line.slice(cursor, seg.s));
      out.push(
        <span key={`s${idx}`} className={seg.cls}>
          {seg.text}
        </span>,
      );
      cursor = seg.e;
    });
    if (cursor < line.length) out.push(line.slice(cursor));
    return out;
  };

  // 文本视图下的高亮渲染
  const renderText = () => {
    if (!text) {
      return (
        <div className="h-full flex items-center justify-center text-textSub text-xs">
          点击 EXPLAIN 查看物理计划
        </div>
      );
    }
    const lines = text.split("\n");
    return (
      <pre className="h-full overflow-auto p-4 text-xs text-textMain font-mono whitespace-pre-wrap break-words leading-relaxed">
        {lines.map((line, i) => {
          // 段头 == xxx Plan == 着重显示
          const isHeader = /^==.*==$/.test(line.trim());
          if (isHeader) {
            return (
              <div
                key={i}
                className={`mt-2 mb-1 px-2 py-0.5 ${headerColor} font-semibold text-[11px] uppercase tracking-wider bg-bgPanel/60 rounded`}
              >
                {line}
              </div>
            );
          }
          // 关键字命中：整行高亮 + 行内 ai_xxx 单独着色
          const hit = highlight?.some((kw) => line.toLowerCase().includes(kw.toLowerCase()));
          if (hit) {
            return (
              <div key={i} className={`px-2 ${lineHighlightBg} ${lineHighlightBorder}`}>
                {renderLineWithInline(line, i)}
              </div>
            );
          }
          return (
            <div key={i} className="px-2">
              {renderLineWithInline(line, i)}
            </div>
          );
        })}
      </pre>
    );
  };

  return (
    <div className="flex flex-col min-w-0 h-full">
      <div className={`px-4 py-2 border-b ${accent} bg-bgPanel/50`}>
        <div className={`text-xs font-semibold uppercase ${headerColor}`}>{title}</div>
        <div className="text-textSub text-[11px] mt-0.5">{subtitle}</div>
      </div>
      <div className="flex-1 overflow-hidden">
        {planTab === "graph" ? <PlanTree tree={tree} /> : renderText()}
      </div>
    </div>
  );
}

// —— 子组件：差异摘要条（统计两侧关键差异） ——
function PlanDiffSummary({ plan }: { plan: ExplainResult }) {
  const findScan = (n: PlanNode | null | undefined): PlanNode | null => {
    if (!n) return null;
    if (n.category === "scan") return n;
    for (const c of n.children) {
      const r = findScan(c);
      if (r) return r;
    }
    return null;
  };

  const optScan = findScan(plan.tree);
  const optPushed = plan.diff?.optimized_pushed_filters ?? optScan?.pushedFilters ?? [];
  const basePushed = plan.diff?.baseline_pushed_filters ?? [];

  const baseLines = plan.diff?.baseline_lines ?? (plan.plan_baseline || "").split("\n").length;
  const pushdownLines = plan.diff?.pushdown_lines ?? (plan.plan_pushdown || "").split("\n").length;
  const optLines = plan.diff?.optimized_lines ?? (plan.plan_optimized || plan.plan || "").split("\n").length;
  const limitBelow = plan.diff?.limit_pushed_below_ai ?? false;

  const aiPosLabel = (pos?: string) => {
    if (pos === "above_filter") return "在 Filter 之上（看全表）";
    if (pos === "above_scan") return "在 Scan 之上（仅看匹配行）";
    return "—";
  };

  return (
    <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-xs flex flex-wrap gap-x-6 gap-y-1 items-center">
      <span className="text-amber-400 font-semibold">⚡ 关键差异</span>

      <span
        className={`px-1.5 py-0.5 rounded font-semibold ${
          limitBelow
            ? "bg-violet-500/20 text-violet-300 border border-violet-500/40"
            : "bg-rose-500/20 text-rose-300 border border-rose-500/40"
        }`}
        title={
          limitBelow
            ? "PostHoc 后 LocalLimit 已搬到 AI Project 之下，规则生效"
            : "未在 PostHoc 形态找到 LocalLimit 在 AI Project 之下"
        }
      >
        {limitBelow ? "✓ LIMIT 已下推到 AI 之下" : "✗ LIMIT 未下推"}
      </span>

      <span className="text-textSub">
        PushedFilters：
        <span className="text-rose-400 font-mono ml-1">未下推 [{basePushed?.length ?? 0}]</span>
        <span className="text-textSub mx-1">→</span>
        <span className="text-teal font-mono">
          已下推 [{optPushed?.length ?? 0}]
          {optPushed && optPushed.length ? `: ${optPushed.join(", ")}` : ""}
        </span>
      </span>

      <span className="text-textSub">
        AI 算子位置：
        <span className="text-rose-400 ml-1">{aiPosLabel(plan.diff?.baseline_ai_position)}</span>
        <span className="text-textSub mx-1">→</span>
        <span className="text-teal">{aiPosLabel(plan.diff?.optimized_ai_position)}</span>
      </span>

      <span className="text-textSub">
        Plan 行数：
        <span className="text-rose-400 font-mono ml-1">① {baseLines}</span>
        <span className="text-textSub mx-1">→</span>
        <span className="text-violet-400 font-mono">② {pushdownLines}</span>
        <span className="text-textSub mx-1">→</span>
        <span className="text-teal font-mono">③ {optLines}</span>
      </span>

      <span className="text-textSub italic ml-auto">
        ② 是规则刚下推完的快照；Spark Optimizer 主 batch 后续可能等价回退（③），但运行时 CollectLimit 仍会限流 AI 调用次数
      </span>
    </div>
  );
}

// —— 一键对照结果迷你卡 ——
function CompareCardMini({ pair }: { pair: { a: SqlSegment; b: SqlSegment } }) {
  const a = pair.a;
  const b = pair.b;
  const aCalls = a.delta?.total_calls ?? 0;
  const bCalls = b.delta?.total_calls ?? 0;
  const aTokens = a.delta?.total_tokens ?? 0;
  const bTokens = b.delta?.total_tokens ?? 0;
  const aMs = a.elapsed_ms ?? 0;
  const bMs = b.elapsed_ms ?? 0;

  const callSaved = aCalls > 0 ? Math.round(((aCalls - bCalls) / aCalls) * 100) : 0;
  const tokenSaved = aTokens > 0 ? Math.round(((aTokens - bTokens) / aTokens) * 100) : 0;
  const msSaved = aMs > 0 ? Math.round(((aMs - bMs) / aMs) * 100) : 0;

  const Row = ({
    label,
    av,
    bv,
    saved,
  }: {
    label: string;
    av: string | number;
    bv: string | number;
    saved: number;
  }) => (
    <div className="flex items-center gap-1 text-[10px] font-mono leading-tight">
      <span className="text-textSub w-12">{label}</span>
      <span className="text-rose-400 flex-1 text-right">{av}</span>
      <span className="text-textSub">→</span>
      <span className="text-teal flex-1 text-right">{bv}</span>
      <span
        className={`w-10 text-right ${
          saved > 0 ? "text-emerald-400" : saved < 0 ? "text-orange-400" : "text-textSub"
        }`}
      >
        {saved > 0 ? `-${saved}%` : saved < 0 ? `+${-saved}%` : "—"}
      </span>
    </div>
  );

  return (
    <div className="mt-2 bg-bgPanel2 border border-amber-500/30 rounded p-2">
      <div className="text-amber-400 text-[10px] font-semibold mb-1.5 flex items-center justify-between">
        <span>📊 对比结果</span>
        <span className="text-textSub font-normal">A → B</span>
      </div>
      <Row label="AI 调用" av={aCalls} bv={bCalls} saved={callSaved} />
      <Row label="Tokens" av={aTokens} bv={bTokens} saved={tokenSaved} />
      <Row label="耗时(ms)" av={aMs} bv={bMs} saved={msSaved} />
      <div className="mt-1.5 pt-1 border-t border-border text-[10px] text-textSub leading-tight">
        {callSaved > 0 ? (
          <span>
            B 节省 <span className="text-emerald-400 font-semibold">{callSaved}%</span> AI 调用
            {tokenSaved > 0 && (
              <>
                ，<span className="text-emerald-400 font-semibold">{tokenSaved}%</span> Tokens
              </>
            )}
          </span>
        ) : (
          <span className="italic">两条 SQL 都触发了相同次数 AI 调用，可能命中行较少</span>
        )}
      </div>
    </div>
  );
}

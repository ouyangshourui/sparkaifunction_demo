/**
 * Workspace · SQL 工作台（取代原 Workbench + Functions）
 *
 * 重构要点：
 *  1. 左栏 3 Tab：Samples / Functions / 段历史
 *  2. EXPLAIN 从"全屏遮罩"改为"右侧 50% 抽屉"，可与编辑器共存
 *  3. 运行结果下方"本次执行卡片"立刻显示 AI 调用 + tokens + 与上次同 SQL 对比
 *  4. Functions 注册表单：cascade 路由用结构化选择器替代手写字符串
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import SqlEditor from "../components/SqlEditor";
import ResultTable from "../components/ResultTable";
import PlanTree from "../components/PlanTree";
import {
  createFunction,
  executeSql,
  explainSql,
  getMetrics,
  listFunctions,
  type ExplainResult,
  type PlanNode,
  type SqlResult,
} from "../api/client";
import {
  appendSegment,
  deriveLabel,
  diffSnapshot,
  emptyDelta,
  loadSegments,
  type SqlSegment,
} from "../lib/segments";
import { fmtCNY, totalCost } from "../lib/pricing";

// ============= 内置 Samples =============
const SAMPLES: { title: string; subtitle: string; sql: string }[] = [
  {
    title: "1. 情感分类",
    subtitle: "ai_classify 内置函数",
    sql: `SELECT id, text,
       ai_classify(text, array('正面','负面','中性')) AS sentiment
FROM reviews
LIMIT 10;`,
  },
  {
    title: "2. 结构化抽取",
    subtitle: "ai_extract schema 模板",
    sql: `SELECT id, content,
       ai_extract(content, '{"intent":"string","priority":"string","need_human":"boolean"}') AS info
FROM tickets
LIMIT 8;`,
  },
  {
    title: "3. 谓词下推",
    subtitle: "看 EXPLAIN 是否把 Filter 推到 AI 之下",
    sql: `SELECT id, text,
       ai_classify(text, array('夸奖','投诉')) AS tag
FROM reviews
WHERE country = 'US' AND sales > 1000
LIMIT 10;`,
  },
  {
    title: "4. 智能路由（Cascade）",
    subtitle: "DDL 注册带 cascade 的 AI 函数",
    sql: `CREATE OR REPLACE AI FUNCTION review_tag(text STRING)
RETURNS STRING
USING MODEL 'cascade(small=hy-mt2-pro, large=hy3-preview, threshold=0.85)'
WITH PROMPT '请用一个词标注情感：{text}'
OPTIONS (batch_max_size='16');

SELECT id, text, review_tag(text) AS tag
FROM reviews
LIMIT 20;`,
  },
  {
    title: "5. LIMIT 下推对照（A）",
    subtitle: "AI 跑全表，浪费",
    sql: `SELECT id, text,
       ai_classify(text, array('夸奖','投诉')) AS tag
FROM reviews
WHERE country = 'US' AND sales > 1000
LIMIT 3;`,
  },
  {
    title: "6. LIMIT 下推对照（B）",
    subtitle: "AI 只跑 3 行，省钱",
    sql: `SELECT id, text,
       ai_classify(text, array('夸奖','投诉')) AS tag
FROM (
  SELECT id, text
  FROM reviews
  WHERE country = 'US' AND sales > 1000
  LIMIT 3
) t;`,
  },
];

type SideTab = "samples" | "functions" | "history";

export default function Workspace() {
  const [sql, setSql] = useState(SAMPLES[0].sql);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [plan, setPlan] = useState<ExplainResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [sideTab, setSideTab] = useState<SideTab>("samples");

  // EXPLAIN 抽屉
  const [drawer, setDrawer] = useState<"closed" | "open">("closed");
  const [planMode, setPlanMode] = useState<"pushdown" | "split" | "baseline" | "optimized">("pushdown");
  const [planTab, setPlanTab] = useState<"graph" | "text">("graph");

  // 上次同 SQL 段（用于运行卡片对比）
  const [lastSeg, setLastSeg] = useState<SqlSegment | null>(null);
  const [thisSeg, setThisSeg] = useState<SqlSegment | null>(null);

  const run = async () => {
    setLoading(true);
    setErr("");
    setResult(null);
    setThisSeg(null);

    // 找出上次同 SQL 的段（用 sql 前 60 字符匹配）
    const allSegs = loadSegments();
    const sigKey = sql.trim().slice(0, 60);
    const prev = [...allSegs].reverse().find((s) => s.sql.trim().slice(0, 60) === sigKey && s.ok);
    setLastSeg(prev || null);

    try {
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
      setThisSeg(seg);
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
      setDrawer("open");
    } catch (e: any) {
      setErr(e.message);
    }
  };

  // ESC 关抽屉
  useEffect(() => {
    if (drawer !== "open") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer("closed");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  return (
    <div className="h-full flex">
      {/* —— 左栏 Tabs —— */}
      <aside className="w-64 flex-none bg-bgPanel border-r border-border flex flex-col">
        <div className="flex border-b border-border">
          {(
            [
              { v: "samples", label: "Samples" },
              { v: "functions", label: "Functions" },
              { v: "history", label: "历史" },
            ] as const
          ).map((t) => (
            <button
              key={t.v}
              onClick={() => setSideTab(t.v)}
              className={`flex-1 py-2 text-xs transition ${
                sideTab === t.v
                  ? "bg-bgPanel2 text-teal border-b-2 border-teal"
                  : "text-textSub hover:text-textMain"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-auto p-2">
          {sideTab === "samples" && <SampleList onPick={setSql} />}
          {sideTab === "functions" && <FunctionsPanel />}
          {sideTab === "history" && <HistoryPanel onPick={setSql} />}
        </div>
      </aside>

      {/* —— 中间编辑器 + 结果 —— */}
      <main
        className={`flex-1 grid gap-2 p-2 ${
          drawer === "open" ? "grid-rows-[40%_60%]" : "grid-rows-[40%_60%]"
        }`}
      >
        <div className="bg-bgPanel border border-border rounded overflow-hidden flex flex-col">
          <div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-bgPanel2">
            <button
              onClick={run}
              disabled={loading}
              className="px-3 py-1 rounded bg-teal hover:bg-tealDeep text-white text-xs font-semibold disabled:opacity-60"
            >
              {loading ? "Running..." : "▶ 运行"}
            </button>
            <button
              onClick={showPlan}
              className="px-3 py-1 rounded bg-bgPanel border border-border hover:bg-bgPanel2 text-textMain text-xs"
            >
              📐 EXPLAIN（右侧抽屉）
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

        {/* 结果区 */}
        <div className="flex flex-col gap-2 min-h-0">
          {/* 本次执行卡片 */}
          {thisSeg && <ExecutionCard seg={thisSeg} prev={lastSeg} />}
          {err && (
            <div className="bg-red-500/10 border border-red-500/30 rounded px-3 py-2 text-xs text-red-300 font-mono">
              {err}
            </div>
          )}

          {/* 结果表 */}
          <div className="flex-1 bg-bgPanel border border-border rounded overflow-hidden flex flex-col min-h-0">
            <div className="px-3 py-1.5 text-xs uppercase text-textSub border-b border-border bg-bgPanel2">
              Result
            </div>
            <ResultTable data={result} />
          </div>
        </div>
      </main>

      {/* —— EXPLAIN 抽屉 —— */}
      {drawer === "open" && (
        <ExplainDrawer
          plan={plan}
          mode={planMode}
          onModeChange={setPlanMode}
          tab={planTab}
          onTabChange={setPlanTab}
          onClose={() => setDrawer("closed")}
        />
      )}
    </div>
  );
}

// ============================================================
// 本次执行卡片
// ============================================================
function ExecutionCard({ seg, prev }: { seg: SqlSegment; prev: SqlSegment | null }) {
  const calls = seg.delta?.total_calls ?? 0;
  const tokens = seg.delta?.total_tokens ?? 0;

  // 本段花费：仅有 tokens_by_model（不区分 prompt/completion），把它喂给 completion 槽估算
  // 这是简化估算，跟 Insights 的 KPI Hero 保持一致逻辑
  const segCost = totalCost({}, seg.delta?.tokens_by_model || {});

  const prevCalls = prev?.delta?.total_calls ?? 0;
  const prevTokens = prev?.delta?.total_tokens ?? 0;

  // 节省（仅当上次同 SQL 跑过且产生了 AI 调用时显示）
  const callDelta = prev && prevCalls > 0 ? Math.round(((prevCalls - calls) / prevCalls) * 100) : null;
  const tokenDelta = prev && prevTokens > 0 ? Math.round(((prevTokens - tokens) / prevTokens) * 100) : null;

  return (
    <div className="bg-bgPanel border border-teal/30 rounded p-2.5 flex items-center gap-4 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="text-teal text-base">✓</span>
        <span className="text-textSub">本次执行</span>
      </div>
      <Pill label="行数" v={seg.row_count.toString()} />
      <Pill label="耗时" v={`${seg.elapsed_ms} ms`} />
      <Pill
        label="AI 调用"
        v={calls.toString()}
        tone={calls === 0 ? "muted" : "teal"}
      />
      <Pill
        label="Tokens"
        v={tokens.toLocaleString()}
        tone={tokens === 0 ? "muted" : "teal"}
      />
      <Pill label="本次花费" v={fmtCNY(segCost)} tone="emerald" />

      {prev && callDelta !== null && (
        <div
          className={`ml-auto px-2 py-1 rounded font-mono font-semibold ${
            callDelta > 0
              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
              : callDelta < 0
              ? "bg-orange-500/10 text-orange-400 border border-orange-500/30"
              : "bg-bgPanel2 text-textSub border border-border"
          }`}
          title={`上次同 SQL：${prevCalls} 次 / ${prevTokens} tokens`}
        >
          {callDelta > 0
            ? `↓ 比上次省 ${callDelta}% AI 调用${tokenDelta && tokenDelta > 0 ? ` · ${tokenDelta}% tokens` : ""}`
            : callDelta < 0
            ? `↑ 比上次多 ${-callDelta}%`
            : "与上次持平"}
        </div>
      )}

      <Link
        to="/insights"
        className="ml-auto text-textSub hover:text-teal text-xs"
        title="查看累计指标"
      >
        📊 看累计 →
      </Link>
    </div>
  );
}

function Pill({ label, v, tone = "default" }: { label: string; v: string; tone?: "default" | "teal" | "emerald" | "muted" }) {
  const cls = {
    default: "text-textMain",
    teal: "text-teal font-semibold",
    emerald: "text-emerald-400 font-semibold",
    muted: "text-textSub/60",
  }[tone];
  return (
    <div className="flex items-center gap-1">
      <span className="text-textSub">{label}</span>
      <span className={`font-mono ${cls}`}>{v}</span>
    </div>
  );
}

// ============================================================
// 左栏 · Samples
// ============================================================
function SampleList({ onPick }: { onPick: (sql: string) => void }) {
  return (
    <div className="space-y-1">
      <div className="text-textSub text-[10px] uppercase tracking-wider px-1 mb-1">
        点击载入到编辑器
      </div>
      {SAMPLES.map((s) => (
        <button
          key={s.title}
          onClick={() => onPick(s.sql)}
          className="w-full text-left px-2 py-1.5 rounded hover:bg-bgPanel2 transition group"
        >
          <div className="text-sm text-textMain group-hover:text-teal">{s.title}</div>
          <div className="text-[10px] text-textSub leading-tight">{s.subtitle}</div>
        </button>
      ))}
    </div>
  );
}

// ============================================================
// 左栏 · Functions（嵌入式注册）
// ============================================================
function FunctionsPanel() {
  const [list, setList] = useState<{ name: string }[]>([]);
  const [name, setName] = useState("review_tag");
  const [returnType, setReturnType] = useState("STRING");
  const [routerMode, setRouterMode] = useState<"single" | "cascade">("cascade");
  const [smallModel, setSmallModel] = useState("hy-mt2-pro");
  const [largeModel, setLargeModel] = useState("hy3-preview");
  const [threshold, setThreshold] = useState(0.85);
  const [singleModel, setSingleModel] = useState("hy-mt2-pro");
  const [prompt, setPrompt] = useState("请用一个词标注情感：{text}");
  const [msg, setMsg] = useState("");

  const refresh = () => listFunctions().then(setList).catch(() => setList([]));
  useEffect(() => {
    refresh();
  }, []);

  const submit = async () => {
    setMsg("");
    const model =
      routerMode === "cascade"
        ? `cascade(small=${smallModel}, large=${largeModel}, threshold=${threshold})`
        : singleModel;
    try {
      await createFunction({
        name,
        return_type: returnType,
        model,
        prompt,
        params: [{ col: "text", type: "STRING" }],
        options: { batch_max_size: "16" },
      });
      setMsg("✓ 已注册");
      refresh();
    } catch (e: any) {
      setMsg(e.response?.data?.detail ?? e.message);
    }
  };

  return (
    <div className="space-y-3 text-xs">
      <div>
        <Label>函数名</Label>
        <input className={inp} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <Label>返回类型</Label>
        <input className={inp} value={returnType} onChange={(e) => setReturnType(e.target.value)} />
      </div>

      <div>
        <Label>路由模式</Label>
        <div className="flex gap-1">
          <button
            onClick={() => setRouterMode("single")}
            className={`flex-1 px-2 py-1 rounded text-[11px] ${
              routerMode === "single" ? "bg-teal text-white" : "bg-bgPanel2 text-textSub border border-border"
            }`}
          >
            单模型
          </button>
          <button
            onClick={() => setRouterMode("cascade")}
            className={`flex-1 px-2 py-1 rounded text-[11px] ${
              routerMode === "cascade" ? "bg-teal text-white" : "bg-bgPanel2 text-textSub border border-border"
            }`}
          >
            Cascade
          </button>
        </div>
      </div>

      {routerMode === "single" ? (
        <div>
          <Label>模型</Label>
          <input className={inp} value={singleModel} onChange={(e) => setSingleModel(e.target.value)} />
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <Label>小模型</Label>
            <input className={inp} value={smallModel} onChange={(e) => setSmallModel(e.target.value)} />
          </div>
          <div>
            <Label>大模型</Label>
            <input className={inp} value={largeModel} onChange={(e) => setLargeModel(e.target.value)} />
          </div>
          <div>
            <Label>阈值（{threshold.toFixed(2)}）</Label>
            <input
              type="range"
              min={0.5}
              max={0.99}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(parseFloat(e.target.value))}
              className="w-full accent-teal"
            />
          </div>
        </div>
      )}

      <div>
        <Label>Prompt（{`{text}`} 占位）</Label>
        <textarea
          rows={3}
          className={inp + " font-mono"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      <button
        onClick={submit}
        className="w-full px-3 py-1.5 rounded bg-teal hover:bg-tealDeep text-white text-xs font-semibold"
      >
        CREATE AI FUNCTION
      </button>
      {msg && <div className={`text-[11px] ${msg.startsWith("✓") ? "text-teal" : "text-amber"}`}>{msg}</div>}

      <div className="pt-2 border-t border-border">
        <Label>已注册（{list.length}）</Label>
        <div className="space-y-1 max-h-40 overflow-auto">
          {list.length === 0 ? (
            <div className="text-textSub text-[11px]">暂无</div>
          ) : (
            list.map((f) => (
              <div key={f.name} className="bg-bgPanel2 px-2 py-1 rounded font-mono text-textMain">
                {f.name}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const inp = "w-full bg-bgPanel2 border border-border rounded px-2 py-1 text-xs text-textMain focus:outline-none focus:border-teal";

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-textSub text-[10px] uppercase tracking-wider mb-0.5">{children}</div>;
}

// ============================================================
// 左栏 · 历史段
// ============================================================
function HistoryPanel({ onPick }: { onPick: (sql: string) => void }) {
  const [segs, setSegs] = useState<SqlSegment[]>(loadSegments());

  useEffect(() => {
    const id = setInterval(() => setSegs(loadSegments()), 1500);
    return () => clearInterval(id);
  }, []);

  if (segs.length === 0) {
    return (
      <div className="text-textSub text-[11px] p-2">
        跑过的 SQL 会自动记录在这里，点击重新载入。
      </div>
    );
  }
  const sorted = [...segs].sort((a, b) => b.ts - a.ts);

  return (
    <div className="space-y-1">
      {sorted.map((s) => {
        const dt = new Date(s.ts);
        const tStr = `${dt.getHours().toString().padStart(2, "0")}:${dt.getMinutes().toString().padStart(2, "0")}`;
        return (
          <button
            key={s.id}
            onClick={() => onPick(s.sql)}
            className="w-full text-left px-2 py-1.5 rounded hover:bg-bgPanel2 transition group border border-transparent hover:border-border"
          >
            <div className="flex items-center gap-1 text-[10px] text-textSub">
              <span>{tStr}</span>
              {s.ok ? (
                <span className="text-teal">✓</span>
              ) : (
                <span className="text-rose-400">✗</span>
              )}
              <span className="ml-auto">
                {s.delta?.total_calls ?? 0} calls · {s.delta?.total_tokens ?? 0} tok
              </span>
            </div>
            <div className="text-xs text-textMain truncate group-hover:text-teal" title={s.sql}>
              {s.label}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// EXPLAIN 右侧抽屉
// ============================================================
type PlanMode = "pushdown" | "split" | "baseline" | "optimized";

function ExplainDrawer({
  plan,
  mode,
  onModeChange,
  tab,
  onTabChange,
  onClose,
}: {
  plan: ExplainResult | null;
  mode: PlanMode;
  onModeChange: (m: PlanMode) => void;
  tab: "graph" | "text";
  onTabChange: (t: "graph" | "text") => void;
  onClose: () => void;
}) {
  return (
    <aside className="w-1/2 min-w-[480px] flex-none bg-bgPanel border-l border-border flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bgPanel2">
        <span className="text-teal text-xs uppercase tracking-wider font-semibold">
          📐 Physical Plan
        </span>
        <div className="ml-2 flex gap-1">
          <ModeBtn active={mode === "pushdown"} onClick={() => onModeChange("pushdown")} tone="violet">
            ② 下推后
          </ModeBtn>
          <ModeBtn active={mode === "split"} onClick={() => onModeChange("split")} tone="amber">
            ⇆ 三栏
          </ModeBtn>
          <ModeBtn active={mode === "baseline"} onClick={() => onModeChange("baseline")} tone="rose">
            ① 未下推
          </ModeBtn>
          <ModeBtn active={mode === "optimized"} onClick={() => onModeChange("optimized")} tone="teal">
            ③ Physical
          </ModeBtn>
        </div>
        <div className="ml-2 flex gap-0.5">
          <ViewBtn active={tab === "graph"} onClick={() => onTabChange("graph")}>
            图形
          </ViewBtn>
          <ViewBtn active={tab === "text"} onClick={() => onTabChange("text")}>
            文本
          </ViewBtn>
        </div>
        <button
          onClick={onClose}
          title="关闭 (Esc)"
          className="ml-auto w-7 h-7 rounded text-textSub hover:text-rose-400 hover:bg-bgPanel border border-border"
        >
          ✕
        </button>
      </div>

      {/* 差异摘要 */}
      {plan && mode === "split" && <DiffBar plan={plan} />}

      <div className="flex-1 overflow-hidden">
        {!plan ? (
          <div className="h-full flex items-center justify-center text-textSub text-xs">
            点 EXPLAIN 加载物理计划
          </div>
        ) : mode === "split" ? (
          <div className="grid grid-cols-3 h-full divide-x divide-border">
            <PlanPane
              title="① 未下推（Parsed）"
              tone="rose"
              tab={tab}
              text={plan.plan_baseline || ""}
              tree={null}
            />
            <PlanPane
              title="② 下推后（Analyzed）"
              tone="violet"
              tab={tab}
              text={plan.plan_pushdown || plan.plan_baseline || ""}
              tree={plan.tree_pushdown ?? plan.tree_baseline ?? null}
            />
            <PlanPane
              title="③ Physical"
              tone="teal"
              tab={tab}
              text={plan.plan_optimized || plan.plan || ""}
              tree={plan.tree ?? null}
            />
          </div>
        ) : mode === "pushdown" ? (
          <PlanPane
            title="② Analyzed · LocalLimit 已搬到 AI 之下"
            tone="violet"
            tab={tab}
            text={plan.plan_pushdown || plan.plan_baseline || ""}
            tree={plan.tree_pushdown ?? plan.tree_baseline ?? null}
          />
        ) : mode === "baseline" ? (
          <PlanPane
            title="① Parsed · 用户原始 SQL"
            tone="rose"
            tab={tab}
            text={plan.plan_baseline || ""}
            tree={null}
          />
        ) : (
          <PlanPane
            title="③ Optimized + Physical · 最终执行形态"
            tone="teal"
            tab={tab}
            text={plan.plan_optimized || plan.plan || ""}
            tree={plan.tree ?? null}
          />
        )}
      </div>
    </aside>
  );
}

function ModeBtn({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone: "rose" | "amber" | "teal" | "violet";
  children: React.ReactNode;
}) {
  const activeCls = {
    rose: "bg-rose-500 text-white",
    amber: "bg-amber-500 text-white",
    teal: "bg-teal text-white",
    violet: "bg-violet-600 text-white",
  }[tone];
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[11px] ${
        active ? activeCls : "bg-bgPanel border border-border text-textSub hover:text-textMain"
      }`}
    >
      {children}
    </button>
  );
}

function ViewBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[11px] ${
        active ? "bg-teal text-white" : "bg-bgPanel border border-border text-textSub hover:text-textMain"
      }`}
    >
      {children}
    </button>
  );
}

function DiffBar({ plan }: { plan: ExplainResult }) {
  const limitBelow = plan.diff?.limit_pushed_below_ai ?? false;
  const optPushed = plan.diff?.optimized_pushed_filters ?? [];
  const basePushed = plan.diff?.baseline_pushed_filters ?? [];
  return (
    <div className="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-[10px] flex flex-wrap gap-x-3 gap-y-1 items-center">
      <span className="text-amber font-bold">⚡ 关键差异</span>
      <span
        className={`px-1.5 py-0.5 rounded font-bold ${
          limitBelow
            ? "bg-violet-500/20 text-violet-300 border border-violet-500/40"
            : "bg-rose-500/20 text-rose-300 border border-rose-500/40"
        }`}
      >
        {limitBelow ? "✓ LIMIT 下推" : "✗ LIMIT 未下推"}
      </span>
      <span className="text-textSub">
        PushedFilters:
        <span className="text-rose-400 font-mono ml-1">[{basePushed?.length ?? 0}]</span>
        <span className="mx-0.5">→</span>
        <span className="text-teal font-mono">[{optPushed?.length ?? 0}]</span>
      </span>
    </div>
  );
}

function PlanPane({
  title,
  tone,
  tab,
  text,
  tree,
}: {
  title: string;
  tone: "rose" | "violet" | "teal";
  tab: "graph" | "text";
  text: string;
  tree: PlanNode | null;
}) {
  const accent = {
    rose: "text-rose-300 border-rose-500/30",
    violet: "text-violet-300 border-violet-500/30",
    teal: "text-teal border-teal/30",
  }[tone];
  return (
    <div className="flex flex-col h-full min-w-0">
      <div className={`px-3 py-1.5 border-b text-[11px] font-bold uppercase tracking-wider ${accent}`}>
        {title}
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === "graph" ? (
          <PlanTree tree={tree} />
        ) : (
          <pre className="h-full overflow-auto p-3 text-[11px] text-textMain font-mono whitespace-pre-wrap leading-relaxed">
            {text || "—"}
          </pre>
        )}
      </div>
    </div>
  );
}

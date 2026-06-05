/**
 * Insights · 治理面板（合并原 Monitor + Recovery）
 *
 * 信息架构：
 *   首屏 = 3 KPI Hero（钱 / 缓存命中 / 路由智能度）
 *   下方 Tabs：
 *     📈 成本趋势  ← 原 Monitor 6 张图，默认只展开核心 2 张
 *     🔁 行级幂等  ← 原 Recovery 整页搬过来
 *     📜 段记录    ← 原 Monitor 底部段对比卡
 *
 * 设计目的：把"工程师看 9 张图"叙事改成"老板看 3 个数 + 钻取细节"。
 * 头号 KPI = 省了多少钱（按 token 价折算），这是 PM 视角能直接报给老板的指标。
 */
import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import {
  clearState,
  flushDelta,
  getMetrics,
  listState,
  loadDelta,
  replay,
  resetMetrics,
  type MetricsSnapshot,
  type StateView,
} from "../api/client";
import { clearSegments, loadSegments, type SqlSegment } from "../lib/segments";
import { fmtCNY, totalCost } from "../lib/pricing";

type Tab = "trend" | "idempotency" | "segments";

export default function Insights() {
  const [m, setM] = useState<MetricsSnapshot>({});
  const [state, setState] = useState<StateView | null>(null);
  const [tab, setTab] = useState<Tab>("trend");

  useEffect(() => {
    const tick = () => {
      getMetrics().then(setM).catch(() => {});
      listState().then(setState).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        {/* KPI Hero */}
        <KpiHero m={m} state={state} />

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border">
          {[
            { v: "trend", label: "📈 成本趋势" },
            { v: "idempotency", label: "🔁 行级幂等 / Replay" },
            { v: "segments", label: "📜 段记录" },
          ].map((t) => (
            <button
              key={t.v}
              onClick={() => setTab(t.v as Tab)}
              className={`px-4 py-2 text-sm border-b-2 -mb-px transition ${
                tab === t.v
                  ? "border-teal text-teal font-semibold"
                  : "border-transparent text-textSub hover:text-textMain"
              }`}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={async () => {
              await resetMetrics();
              setM({});
            }}
            className="ml-auto text-xs text-textSub hover:text-rose-400 px-2 py-1"
          >
            ↻ 清零所有计数
          </button>
        </div>

        {/* Tab 内容 */}
        <div className="pb-12">
          {tab === "trend" && <TrendTab m={m} />}
          {tab === "idempotency" && <IdempotencyTab state={state} onRefresh={() => listState().then(setState).catch(() => {})} />}
          {tab === "segments" && <SegmentsTab />}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// KPI Hero —— 3 个核心指标
// ============================================================
function KpiHero({ m, state }: { m: MetricsSnapshot; state: StateView | null }) {
  const cost = totalCost(m.prompt_tokens_by_model, m.completion_tokens_by_model);
  const tokens = m.total_tokens ?? 0;
  const totalCalls = m.total_calls ?? 0;

  // Cache 命中率 = (cached_count + audit_pending) / 估算总尝试数
  // 真实总尝试数无法直接读到（Governance 只记成功调用），
  // 这里用 cached_count 作为"已缓存条数"展示
  const cached = state?.cached_count ?? 0;
  const persisted = state?.persisted_count ?? 0;

  // 路由分布
  const routed = m.routed_distribution ?? {};
  const smallOnly = routed.small_only ?? 0;
  const upgraded = routed.upgraded ?? 0;
  const fallback = routed.fallback ?? 0;
  const failed = routed.failed ?? 0;
  const totalRouted = smallOnly + upgraded + fallback + failed;
  const smallPct = totalRouted > 0 ? Math.round((smallOnly / totalRouted) * 100) : 0;
  const upgradePct = totalRouted > 0 ? Math.round((upgraded / totalRouted) * 100) : 0;

  return (
    <div className="grid md:grid-cols-3 gap-4">
      {/* KPI 1：花了多少钱 */}
      <KpiCard
        label="累计花费（按 token 价折算）"
        value={fmtCNY(cost)}
        subValue={`${tokens.toLocaleString()} tokens · ${totalCalls} 次调用`}
        tone="emerald"
        emoji="💰"
        footer={
          m.budget_exhausted
            ? "⚠️ 预算耗尽，已自动降级到 small"
            : `预算 ${(m.token_budget ?? 0).toLocaleString()} · 已用 ${
                (m.token_budget ?? 0) > 0
                  ? Math.round(((tokens / (m.token_budget ?? 1)) * 100))
                  : 0
              }%`
        }
      />

      {/* KPI 2：行级幂等命中数 */}
      <KpiCard
        label="行级幂等命中"
        value={cached.toLocaleString()}
        subValue={`Iceberg 已持久化 ${persisted < 0 ? "—" : persisted.toLocaleString()} 条`}
        tone="teal"
        emoji="🎯"
        footer={
          cached > 0
            ? `${cached} 条 prompt_hash → output 缓存中，重跑零成本`
            : "尚无缓存。Workspace 跑一条 ai_classify 试试"
        }
      />

      {/* KPI 3：智能路由 */}
      <KpiCard
        label="智能路由"
        value={
          totalRouted > 0
            ? `${smallPct}% 小`
            : "—"
        }
        subValue={
          totalRouted > 0
            ? `${upgradePct}% 升级 · ${fallback} 兜底 · ${failed} 失败`
            : "尚无 cascade 路由记录"
        }
        tone="violet"
        emoji="🔀"
        footer={
          totalRouted > 0
            ? `${smallOnly + upgraded} 次成功 / ${totalRouted} 次路由 — 越多 small_only 越省钱`
            : "在 Functions 注册 cascade(small=..., large=..., threshold=...) 即可启用"
        }
      />
    </div>
  );
}

function KpiCard({
  label,
  value,
  subValue,
  tone,
  emoji,
  footer,
}: {
  label: string;
  value: string;
  subValue: string;
  tone: "emerald" | "teal" | "violet";
  emoji: string;
  footer: string;
}) {
  const cls = {
    emerald: "from-emerald-500/10 border-emerald-500/30",
    teal: "from-teal/10 border-teal/30",
    violet: "from-violet-500/10 border-violet-500/30",
  }[tone];
  const valColor = {
    emerald: "text-emerald-400",
    teal: "text-teal",
    violet: "text-violet-300",
  }[tone];
  return (
    <div className={`bg-gradient-to-br ${cls} to-bgPanel border rounded-lg p-4`}>
      <div className="flex items-start justify-between mb-2">
        <div className="text-textSub text-xs uppercase tracking-wider">{label}</div>
        <div className="text-2xl">{emoji}</div>
      </div>
      <div className={`text-3xl font-bold font-mono ${valColor}`}>{value}</div>
      <div className="text-textSub text-xs mt-1">{subValue}</div>
      <div className="text-textSub/70 text-[11px] mt-3 pt-2 border-t border-border/50 leading-relaxed">
        {footer}
      </div>
    </div>
  );
}

// ============================================================
// Tab 1: 成本趋势
// ============================================================
function TrendTab({ m }: { m: MetricsSnapshot }) {
  const callsByModel = m.calls_by_model ?? {};
  const promptByModel = m.prompt_tokens_by_model ?? {};
  const completionByModel = m.completion_tokens_by_model ?? {};
  const latencyByModel = m.latency_ms_by_model ?? {};
  const routed = m.routed_distribution ?? {};

  const modelKeys = Array.from(
    new Set([
      ...Object.keys(callsByModel),
      ...Object.keys(promptByModel),
      ...Object.keys(completionByModel),
    ]),
  ).sort();

  const empty = modelKeys.length === 0;

  if (empty) {
    return (
      <div className="bg-bgPanel border border-border rounded p-8 text-center text-textSub text-sm">
        尚无 AI 调用记录
        <div className="text-xs mt-2 text-textSub/60">
          打开 Workspace 跑一条 SELECT ai_classify(...) FROM reviews，回来看图表
        </div>
      </div>
    );
  }

  const pieData = Object.entries(routed)
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([n, v]) => ({ name: routedLabel(n), value: v }));

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <ChartCard title="模型调用次数">
        <ReactECharts
          style={{ height: 260 }}
          option={{
            tooltip: {},
            xAxis: {
              type: "category",
              data: modelKeys,
              axisLabel: { color: "#8b949e", interval: 0, rotate: 30 },
            },
            yAxis: { type: "value", axisLabel: { color: "#8b949e" } },
            series: [
              {
                type: "bar",
                data: modelKeys.map((k) => callsByModel[k] ?? 0),
                itemStyle: { color: "#0d9488" },
              },
            ],
            grid: { top: 10, right: 10, bottom: 60, left: 40 },
          }}
        />
      </ChartCard>

      <ChartCard title="Prompt vs Completion Tokens（堆叠）">
        <ReactECharts
          style={{ height: 260 }}
          option={{
            tooltip: { trigger: "axis" },
            legend: { textStyle: { color: "#8b949e" }, bottom: 0 },
            xAxis: {
              type: "category",
              data: modelKeys,
              axisLabel: { color: "#8b949e", interval: 0, rotate: 30 },
            },
            yAxis: { type: "value", axisLabel: { color: "#8b949e" } },
            series: [
              {
                name: "prompt",
                type: "bar",
                stack: "tok",
                data: modelKeys.map((k) => promptByModel[k] ?? 0),
                itemStyle: { color: "#3b82f6" },
              },
              {
                name: "completion",
                type: "bar",
                stack: "tok",
                data: modelKeys.map((k) => completionByModel[k] ?? 0),
                itemStyle: { color: "#0d9488" },
              },
            ],
            grid: { top: 10, right: 10, bottom: 60, left: 50 },
          }}
        />
      </ChartCard>

      {/* 折叠：路由饼图 */}
      <details className="md:col-span-2">
        <summary className="cursor-pointer text-textSub hover:text-textMain text-sm py-2">
          ▸ 详细：路由分布 / 按模型详情表
        </summary>
        <div className="grid md:grid-cols-2 gap-4 mt-3">
          <ChartCard title="路由分布（small_only / upgraded / fallback / failed）">
            {pieData.length > 0 ? (
              <ReactECharts
                style={{ height: 240 }}
                option={{
                  tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
                  legend: { textStyle: { color: "#8b949e" }, bottom: 0 },
                  series: [
                    {
                      type: "pie",
                      radius: ["40%", "70%"],
                      center: ["50%", "45%"],
                      data: pieData,
                      label: { color: "#2c2a26" },
                    },
                  ],
                  color: ["#0d9488", "#f59e0b", "#dc2626", "#3b82f6"],
                }}
              />
            ) : (
              <div className="h-[240px] flex items-center justify-center text-textSub text-xs">
                尚无 cascade 路由（注册 AI Function 时用 cascade(small,large,threshold) 启用）
              </div>
            )}
          </ChartCard>

          <ChartCard title="按模型详细统计">
            <div className="overflow-auto max-h-[240px]">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-textSub border-b border-border">
                    <th className="text-left p-2">模型</th>
                    <th className="text-right p-2">调用</th>
                    <th className="text-right p-2">prompt</th>
                    <th className="text-right p-2">completion</th>
                    <th className="text-right p-2">avg latency</th>
                  </tr>
                </thead>
                <tbody>
                  {modelKeys.map((k) => {
                    const calls = callsByModel[k] ?? 0;
                    const pt = promptByModel[k] ?? 0;
                    const ct = completionByModel[k] ?? 0;
                    const lat = latencyByModel[k] ?? 0;
                    const avg = calls > 0 ? lat / calls : 0;
                    return (
                      <tr key={k} className="border-b border-border/50 hover:bg-bgPanel2">
                        <td className="p-2 text-textMain">{k}</td>
                        <td className="text-right p-2">{calls.toLocaleString()}</td>
                        <td className="text-right p-2">{pt.toLocaleString()}</td>
                        <td className="text-right p-2">{ct.toLocaleString()}</td>
                        <td className="text-right p-2">{avg.toFixed(0)} ms</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </ChartCard>
        </div>
      </details>

      {/* 折叠：原始 JSON */}
      <details className="md:col-span-2">
        <summary className="cursor-pointer text-textSub hover:text-textMain text-sm py-2">
          ▸ 调试：原始 metrics JSON
        </summary>
        <pre className="bg-bgDark border border-border rounded p-3 mt-2 text-[11px] text-textSub whitespace-pre-wrap font-mono max-h-60 overflow-auto">
          {JSON.stringify(m, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bgPanel border border-border rounded p-4">
      <div className="text-teal text-xs uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

function routedLabel(n: string): string {
  const map: Record<string, string> = {
    small_only: "small_only（小模型一击命中）",
    upgraded: "upgraded（升级到 large）",
    fallback: "fallback（small 失败兜底 large）",
    failed: "failed（彻底失败）",
  };
  return map[n] || n;
}

// ============================================================
// Tab 2: 行级幂等（原 Recovery）
// ============================================================
function IdempotencyTab({
  state,
  onRefresh,
}: {
  state: StateView | null;
  onRefresh: () => void;
}) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const wrap = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg("");
    try {
      const m = await fn();
      setMsg(m);
      onRefresh();
    } catch (e: any) {
      setMsg(`✗ ${e?.response?.data?.detail ?? e?.message ?? "失败"}`);
    } finally {
      setBusy(false);
    }
  };

  const cached = state?.cached_count ?? 0;
  const audit = state?.audit_pending ?? 0;
  const persisted = state?.persisted_count ?? 0;
  const table = state?.table ?? "local.default.ai_inference_state";
  const sample = state?.sample ?? [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <MetricCard label="Executor 内存缓存" value={cached} hint="prompt_hash → output" tone="teal" />
        <MetricCard label="待 flush Audit" value={audit} hint="本批新成功调用，未落盘" tone="amber" />
        <MetricCard
          label="Iceberg 已持久化"
          value={persisted < 0 ? "—" : persisted}
          hint={table}
          tone="violet"
        />
      </div>

      <div className="bg-bgPanel border border-border rounded p-4">
        <div className="text-teal text-sm uppercase tracking-wider mb-3">状态恢复操作</div>
        <div className="flex flex-wrap gap-2 items-center">
          <ActionBtn
            disabled={busy}
            tone="teal"
            onClick={() => wrap(async () => {
              const r = await flushDelta();
              return `✓ Flush：${r.flushed} 条 audit → ${r.table}`;
            })}
          >
            ⇩ Flush 到 Iceberg
          </ActionBtn>
          <ActionBtn
            disabled={busy}
            tone="teal"
            onClick={() => wrap(async () => {
              const r = await loadDelta();
              return `✓ Load：从 ${r.table} 加载 ${r.loaded} 条到 cache`;
            })}
          >
            ⇧ 从 Iceberg Load
          </ActionBtn>
          <ActionBtn
            disabled={busy}
            tone="amber"
            onClick={() => wrap(async () => {
              const r = await clearState();
              return `✓ 已清空 ${r.cleared} 条 cache（Iceberg 数据保留）`;
            })}
          >
            ✕ 清空 cache
          </ActionBtn>
          <ActionBtn
            disabled={busy}
            tone="violet"
            onClick={() => wrap(async () => {
              const r = await replay();
              return `✓ ${r.message}`;
            })}
          >
            ▶ Replay (Flush→Clear→Load)
          </ActionBtn>
          <span className={`text-sm self-center ml-2 ${msg.startsWith("✗") ? "text-red-400" : "text-textSub"}`}>
            {busy ? "执行中…" : msg}
          </span>
        </div>
      </div>

      {/* Cache 样例 */}
      <div className="bg-bgPanel border border-border rounded p-4">
        <div className="text-teal text-sm uppercase tracking-wider mb-2">Cache 样例（最多 20 条）</div>
        {sample.length === 0 ? (
          <div className="text-textSub text-sm">
            暂无缓存。先到 Workspace 跑一条 ai_classify / ai_extract。
          </div>
        ) : (
          <table className="w-full text-xs font-mono">
            <thead className="text-textSub border-b border-border">
              <tr>
                <th className="text-left py-1.5 w-40">prompt_hash</th>
                <th className="text-left py-1.5">output preview</th>
              </tr>
            </thead>
            <tbody>
              {sample.map((e, i) => (
                <tr key={i} className="border-b border-border/40 hover:bg-bgPanel2">
                  <td className="py-1 text-amber">{e.hash}</td>
                  <td className="py-1 text-textMain">{e.preview}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint: string;
  tone: "teal" | "amber" | "violet";
}) {
  const c = {
    teal: "text-teal",
    amber: "text-amber",
    violet: "text-violet-400",
  }[tone];
  return (
    <div className="bg-bgPanel border border-border rounded p-4">
      <div className="text-textSub text-xs uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-3xl font-mono ${c}`}>{value}</div>
      <div className="text-textSub text-xs mt-1">{hint}</div>
    </div>
  );
}

function ActionBtn({
  onClick,
  children,
  tone,
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  tone: "teal" | "amber" | "violet";
  disabled?: boolean;
}) {
  const cls = {
    teal: "bg-teal text-white hover:opacity-90",
    amber: "bg-amber text-bgDark hover:opacity-90 font-semibold",
    violet: "bg-violet-600 text-white hover:opacity-90",
  }[tone];
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`px-3 py-1.5 rounded text-sm transition disabled:opacity-50 disabled:cursor-not-allowed ${cls}`}
    >
      {children}
    </button>
  );
}

// ============================================================
// Tab 3: 段记录
// ============================================================
function SegmentsTab() {
  const [segs, setSegs] = useState<SqlSegment[]>(loadSegments());

  useEffect(() => {
    const tick = () => setSegs(loadSegments());
    tick();
    const id = setInterval(tick, 1500);
    const onChange = () => tick();
    window.addEventListener("aifn:segments-change", onChange);
    return () => {
      clearInterval(id);
      window.removeEventListener("aifn:segments-change", onChange);
    };
  }, []);

  if (segs.length === 0) {
    return (
      <div className="bg-bgPanel border border-border rounded p-8 text-center text-textSub text-sm">
        尚无段记录
        <div className="text-xs mt-2 text-textSub/60">
          切到 Workspace 跑 SQL，每次执行都会自动记一段（含 AI 调用、Tokens、耗时差量）
        </div>
      </div>
    );
  }

  const sorted = [...segs].sort((a, b) => b.ts - a.ts);
  const b = sorted[0];
  const a = sorted[1];

  return (
    <div className="space-y-3">
      {a && b && <PairCompare a={a} b={b} />}

      <div className="bg-bgPanel border border-border rounded p-3 overflow-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-textSub border-b border-border">
              <th className="text-left p-1.5 w-8">#</th>
              <th className="text-left p-1.5">时间</th>
              <th className="text-left p-1.5">标签</th>
              <th className="text-right p-1.5">行数</th>
              <th className="text-right p-1.5">耗时</th>
              <th className="text-right p-1.5">AI调用</th>
              <th className="text-right p-1.5">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s, i) => {
              const dt = new Date(s.ts);
              const tStr = `${dt.getHours().toString().padStart(2, "0")}:${dt
                .getMinutes()
                .toString()
                .padStart(2, "0")}:${dt.getSeconds().toString().padStart(2, "0")}`;
              const calls = s.delta?.total_calls ?? 0;
              const toks = s.delta?.total_tokens ?? 0;
              const cls =
                i === 0
                  ? "border-b border-border/50 bg-teal/10"
                  : i === 1
                  ? "border-b border-border/50 bg-rose-500/5"
                  : "border-b border-border/50 hover:bg-bgPanel2";
              return (
                <tr key={s.id} className={cls}>
                  <td className="p-1.5">
                    <span
                      className={`inline-block w-5 text-center rounded text-[10px] font-bold ${
                        i === 0
                          ? "bg-teal text-white"
                          : i === 1
                          ? "bg-rose-500 text-white"
                          : "bg-bgPanel2 text-textSub"
                      }`}
                    >
                      {i === 0 ? "B" : i === 1 ? "A" : sorted.length - i}
                    </span>
                  </td>
                  <td className="p-1.5 text-textSub">{tStr}</td>
                  <td className="p-1.5 text-textMain truncate max-w-md" title={s.sql}>
                    {s.label}
                  </td>
                  <td className="text-right p-1.5">{s.row_count ?? 0}</td>
                  <td className="text-right p-1.5">{s.elapsed_ms ?? 0} ms</td>
                  <td className={`text-right p-1.5 ${calls > 0 ? "text-teal" : "text-textSub"}`}>
                    {calls}
                  </td>
                  <td className={`text-right p-1.5 ${toks > 0 ? "text-teal" : "text-textSub"}`}>
                    {toks}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => {
            clearSegments();
            setSegs([]);
          }}
          className="px-3 py-1 bg-bgPanel2 border border-border rounded text-xs text-textSub hover:text-rose-400 hover:border-rose-400 transition"
        >
          清空段记录
        </button>
      </div>
    </div>
  );
}

function PairCompare({ a, b }: { a: SqlSegment; b: SqlSegment }) {
  const aCalls = a.delta?.total_calls ?? 0;
  const bCalls = b.delta?.total_calls ?? 0;
  const aTokens = a.delta?.total_tokens ?? 0;
  const bTokens = b.delta?.total_tokens ?? 0;
  const aMs = a.elapsed_ms ?? 0;
  const bMs = b.elapsed_ms ?? 0;

  const callSaved = aCalls > 0 ? Math.round(((aCalls - bCalls) / aCalls) * 100) : 0;
  const tokenSaved = aTokens > 0 ? Math.round(((aTokens - bTokens) / aTokens) * 100) : 0;
  const msSaved = aMs > 0 ? Math.round(((aMs - bMs) / aMs) * 100) : 0;

  return (
    <div className="bg-amber-500/5 border border-amber-500/30 rounded p-3">
      <div className="text-amber-400 text-xs font-semibold mb-2">
        ⚡ 最近两段对比（A 倒数第二 → B 最新）
      </div>
      <div className="grid grid-cols-3 gap-3">
        <CmpTile label="AI 调用" av={aCalls} bv={bCalls} saved={callSaved} />
        <CmpTile label="Tokens" av={aTokens} bv={bTokens} saved={tokenSaved} />
        <CmpTile label="耗时" av={aMs} bv={bMs} saved={msSaved} unit="ms" />
      </div>
    </div>
  );
}

function CmpTile({
  label,
  av,
  bv,
  saved,
  unit = "",
}: {
  label: string;
  av: number;
  bv: number;
  saved: number;
  unit?: string;
}) {
  return (
    <div className="bg-bgPanel2 rounded p-2 border border-border">
      <div className="text-textSub text-[11px] uppercase tracking-wider mb-1">{label}</div>
      <div className="font-mono">
        <span className="text-rose-400 text-sm">{av.toLocaleString()}{unit}</span>
        <span className="text-textSub mx-1.5">→</span>
        <span className="text-teal text-lg font-bold">{bv.toLocaleString()}{unit}</span>
      </div>
      <div
        className={`text-xs font-semibold mt-1 ${
          saved > 0 ? "text-emerald-400" : saved < 0 ? "text-orange-400" : "text-textSub"
        }`}
      >
        {saved > 0 ? `↓ ${saved}%` : saved < 0 ? `↑ ${-saved}%` : "持平"}
      </div>
    </div>
  );
}

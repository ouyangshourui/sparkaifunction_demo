import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getMetrics, resetMetrics, MetricsSnapshot } from "../api/client";
import { loadSegments, clearSegments, type SqlSegment } from "../lib/segments";

/**
 * Monitor —— Token / 调用 / 路由可视化
 *
 * 数据源：JVM 端 Governance.snapshotJson()（用 Jackson 直接拼 JSON，避开 py4j 嵌套 Map 桥接坑）
 * 维度：
 *  - 每模型 prompt / completion / total tokens
 *  - 每模型 调用次数 + 平均时延
 *  - 路由分布 small_only / upgraded / fallback / failed
 *  - Token 预算使用率 + 告警
 */
export default function Monitor() {
  const [m, setM] = useState<MetricsSnapshot>({});
  const [hint, setHint] = useState<string>("");
  const [segments, setSegments] = useState<SqlSegment[]>([]);

  useEffect(() => {
    const tick = () =>
      getMetrics()
        .then((d) => {
          setM(d);
          setHint("");
        })
        .catch((e) => setHint(`metrics 拉取失败：${e?.message || e}`));
    tick();
    const id = setInterval(tick, 1500);

    // 段记录从 localStorage 读
    const tickSeg = () => setSegments(loadSegments());
    tickSeg();
    const sid = setInterval(tickSeg, 2000);
    // 也监听 storage 事件（其他 tab 写入时同步）
    const onStorage = (e: StorageEvent) => {
      if (e.key === "aifn:segments") tickSeg();
    };
    window.addEventListener("storage", onStorage);

    return () => {
      clearInterval(id);
      clearInterval(sid);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const tokens = m.total_tokens ?? 0;
  const promptTokens = m.total_prompt_tokens ?? 0;
  const completionTokens = m.total_completion_tokens ?? 0;
  const totalCalls = m.total_calls ?? 0;
  const avgLatency = m.avg_latency_ms ?? 0;
  const budget = m.token_budget ?? 1_000_000;
  const usePct = budget ? Math.min(100, (tokens / budget) * 100) : 0;

  const routed = m.routed_distribution ?? {};
  const pieData = Object.entries(routed)
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([n, v]) => ({ name: routedLabel(n), value: v }));

  const callsByModel = m.calls_by_model ?? {};
  const tokensByModel = m.tokens_by_model ?? {};
  const promptByModel = m.prompt_tokens_by_model ?? {};
  const completionByModel = m.completion_tokens_by_model ?? {};
  const latencyByModel = m.latency_ms_by_model ?? {};

  // 联合所有模型 key（calls / tokens 都可能有），保证表格一致
  const modelKeys = Array.from(
    new Set([
      ...Object.keys(callsByModel),
      ...Object.keys(tokensByModel),
      ...Object.keys(promptByModel),
      ...Object.keys(completionByModel),
    ]),
  ).sort();

  const onReset = async () => {
    await resetMetrics();
    setM({});
  };

  const empty = totalCalls === 0;

  return (
    <div className="h-full grid grid-cols-3 gap-3 p-3 overflow-auto">
      {hint && (
        <div className="col-span-3 bg-red-900/20 border border-red-700 text-red-300 rounded p-2 text-xs">
          {hint}
        </div>
      )}

      <Card title="总调用 / 平均时延">
        <div className="text-3xl text-teal font-bold">{totalCalls.toLocaleString()}</div>
        <div className="text-textSub text-xs mt-1">总调用次数</div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <Stat label="avg latency" val={`${avgLatency.toFixed(0)} ms`} />
          <Stat label="total latency" val={`${(m.total_latency_ms ?? 0).toLocaleString()} ms`} />
        </div>
      </Card>

      <Card title="Token 使用">
        <div className="text-3xl text-teal font-bold">{tokens.toLocaleString()}</div>
        <div className="text-textSub text-xs mt-1">
          预算 {budget.toLocaleString()} · 已用 {usePct.toFixed(2)}%
        </div>
        <div className="mt-3 h-2 bg-bgPanel2 rounded overflow-hidden">
          <div
            className={`h-full ${m.budget_exhausted ? "bg-red-500" : "bg-teal"}`}
            style={{ width: `${usePct}%` }}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <Stat label="prompt" val={promptTokens.toLocaleString()} />
          <Stat label="completion" val={completionTokens.toLocaleString()} />
        </div>
      </Card>

      <Card title="预算告警">
        {m.budget_exhausted ? (
          <div className="text-red-400 font-bold text-sm leading-relaxed">
            ⚠️ Token 预算已耗尽
            <div className="text-xs text-red-300 mt-2 font-normal">
              ModelRouter 自动降级，仅跑 small；新行将不再升级 large。
            </div>
          </div>
        ) : (
          <div className="text-textSub text-sm">
            预算正常
            <div className="text-xs mt-2 leading-relaxed">
              使用率 {usePct.toFixed(2)}%，距离触发降级 {(budget - tokens).toLocaleString()} tokens。
            </div>
          </div>
        )}
        <button
          onClick={onReset}
          className="mt-3 px-3 py-1 bg-bgPanel2 border border-border rounded text-xs text-textSub hover:text-textMain hover:border-teal transition"
        >
          清零计数
        </button>
      </Card>

      <Card title="路由分布（small_only / upgraded / fallback）">
        {pieData.length > 0 ? (
          <ReactECharts
            style={{ height: 220 }}
            option={{
              tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
              legend: { textStyle: { color: "#8b949e" }, bottom: 0 },
              series: [
                {
                  type: "pie",
                  radius: ["40%", "70%"],
                  center: ["50%", "45%"],
                  data: pieData,
                  label: { color: "#e6edf3" },
                },
              ],
              color: ["#0d9488", "#f59e0b", "#dc2626", "#3b82f6"],
            }}
          />
        ) : (
          <EmptyHint text={empty ? "尚无 AI 调用，跑一条 ai_classify SQL 试试" : "无路由数据"} />
        )}
      </Card>

      <Card title="模型调用次数">
        {modelKeys.length > 0 ? (
          <ReactECharts
            style={{ height: 220 }}
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
        ) : (
          <EmptyHint text="尚无模型调用" />
        )}
      </Card>

      <Card title="模型 Token 分布（prompt vs completion）">
        {modelKeys.length > 0 ? (
          <ReactECharts
            style={{ height: 220 }}
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
        ) : (
          <EmptyHint text="尚无 token 数据" />
        )}
      </Card>

      <Card title="按模型详细统计" wide>
        <div className="overflow-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-textSub border-b border-border">
                <th className="text-left p-2">模型</th>
                <th className="text-right p-2">调用次数</th>
                <th className="text-right p-2">prompt tokens</th>
                <th className="text-right p-2">completion tokens</th>
                <th className="text-right p-2">total tokens</th>
                <th className="text-right p-2">avg latency</th>
              </tr>
            </thead>
            <tbody>
              {modelKeys.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center p-4 text-textSub">
                    {empty ? "尚未发起 AI 调用 — 切回 Workbench 跑一条 SELECT ai_classify(...) 试试" : "无数据"}
                  </td>
                </tr>
              )}
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
                    <td className="text-right p-2 text-teal">{(pt + ct).toLocaleString()}</td>
                    <td className="text-right p-2">{avg.toFixed(0)} ms</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="按 SQL 段记录（同一会话两条 SQL 自动出对比卡）" wide colSpan={3}>
        <SegmentCompareCard segments={segments} onClear={() => { clearSegments(); setSegments([]); }} />
      </Card>

      <Card title="原始指标 JSON" wide colSpan={3}>
        <pre className="text-xs text-textSub whitespace-pre-wrap font-mono max-h-60 overflow-auto">
          {JSON.stringify(m, null, 2)}
        </pre>
      </Card>
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

function Stat({ label, val }: { label: string; val: string }) {
  return (
    <div className="bg-bgPanel2 rounded px-2 py-1.5">
      <div className="text-textSub">{label}</div>
      <div className="text-textMain font-mono">{val}</div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="h-[220px] flex items-center justify-center text-textSub text-xs">
      {text}
    </div>
  );
}

function Card({
  title,
  children,
  wide,
  colSpan,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
  colSpan?: number;
}) {
  return (
    <div
      className={`bg-bgPanel border border-border rounded p-4 ${wide ? "col-span-3" : ""}`}
      style={colSpan ? { gridColumn: `span ${colSpan}` } : undefined}
    >
      <div className="text-teal text-xs uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

// —— 按 SQL 段记录的对比卡 ——
function SegmentCompareCard({
  segments,
  onClear,
}: {
  segments: SqlSegment[];
  onClear: () => void;
}) {
  if (segments.length === 0) {
    return (
      <div className="text-textSub text-xs italic">
        尚无段记录。切回 Workbench 跑一条 SQL，每次运行都会自动记一段（含 AI 调用、Tokens、耗时差量）。
        <br />
        建议跑两条：例如先「LIMIT 在外层」再「LIMIT 在子查询」，本卡片会自动给出对比。
      </div>
    );
  }

  // 取最近两段做对比（B = 最新；A = 倒数第二）
  const sorted = [...segments].sort((x, y) => y.ts - x.ts);
  const b = sorted[0];
  const a = sorted[1];

  return (
    <div className="space-y-3">
      {a && b && <SegmentDiffRow a={a} b={b} />}

      <div className="overflow-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-textSub border-b border-border">
              <th className="text-left p-1.5 w-8">#</th>
              <th className="text-left p-1.5">时间</th>
              <th className="text-left p-1.5">标签</th>
              <th className="text-right p-1.5">行数</th>
              <th className="text-right p-1.5">耗时(ms)</th>
              <th className="text-right p-1.5">AI调用</th>
              <th className="text-right p-1.5">Tokens</th>
              <th className="text-right p-1.5">prompt/comp</th>
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
              const pt = s.delta?.total_prompt_tokens ?? 0;
              const ct = s.delta?.total_completion_tokens ?? 0;
              const isLatest = i === 0;
              const isPrev = i === 1;
              const rowClass = isLatest
                ? "border-b border-border/50 bg-teal/10"
                : isPrev
                ? "border-b border-border/50 bg-rose-500/5"
                : "border-b border-border/50 hover:bg-bgPanel2";
              return (
                <tr key={s.id} className={rowClass}>
                  <td className="p-1.5">
                    <span
                      className={`inline-block w-5 text-center rounded text-[10px] font-bold ${
                        isLatest
                          ? "bg-teal text-white"
                          : isPrev
                          ? "bg-rose-500 text-white"
                          : "bg-bgPanel2 text-textSub"
                      }`}
                    >
                      {isLatest ? "B" : isPrev ? "A" : sorted.length - i}
                    </span>
                  </td>
                  <td className="p-1.5 text-textSub">{tStr}</td>
                  <td className="p-1.5 text-textMain truncate max-w-md" title={s.sql}>
                    {s.label}
                  </td>
                  <td className="text-right p-1.5">{s.row_count ?? 0}</td>
                  <td className="text-right p-1.5">{s.elapsed_ms ?? 0}</td>
                  <td className={`text-right p-1.5 ${calls > 0 ? "text-teal" : "text-textSub"}`}>
                    {calls}
                  </td>
                  <td className={`text-right p-1.5 ${toks > 0 ? "text-teal" : "text-textSub"}`}>
                    {toks}
                  </td>
                  <td className="text-right p-1.5 text-textSub">
                    {pt}/{ct}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end pt-1">
        <button
          onClick={onClear}
          className="px-3 py-1 bg-bgPanel2 border border-border rounded text-xs text-textSub hover:text-textMain hover:border-rose-500 transition"
        >
          清空段记录
        </button>
      </div>
    </div>
  );
}

function SegmentDiffRow({ a, b }: { a: SqlSegment; b: SqlSegment }) {
  const aCalls = a.delta?.total_calls ?? 0;
  const bCalls = b.delta?.total_calls ?? 0;
  const aTokens = a.delta?.total_tokens ?? 0;
  const bTokens = b.delta?.total_tokens ?? 0;
  const aMs = a.elapsed_ms ?? 0;
  const bMs = b.elapsed_ms ?? 0;

  const callSaved = aCalls > 0 ? Math.round(((aCalls - bCalls) / aCalls) * 100) : 0;
  const tokenSaved = aTokens > 0 ? Math.round(((aTokens - bTokens) / aTokens) * 100) : 0;
  const msSaved = aMs > 0 ? Math.round(((aMs - bMs) / aMs) * 100) : 0;

  const Tile = ({
    title,
    av,
    bv,
    saved,
    unit = "",
  }: {
    title: string;
    av: number;
    bv: number;
    saved: number;
    unit?: string;
  }) => (
    <div className="bg-bgPanel2 rounded p-3 border border-border">
      <div className="text-textSub text-[11px] uppercase tracking-wider mb-1">{title}</div>
      <div className="flex items-baseline gap-2 font-mono">
        <span className="text-rose-400 text-sm">{av.toLocaleString()}{unit}</span>
        <span className="text-textSub">→</span>
        <span className="text-teal text-xl font-bold">{bv.toLocaleString()}{unit}</span>
      </div>
      <div
        className={`text-xs font-semibold mt-1 ${
          saved > 0 ? "text-emerald-400" : saved < 0 ? "text-orange-400" : "text-textSub"
        }`}
      >
        {saved > 0
          ? `↓ 节省 ${saved}%`
          : saved < 0
          ? `↑ 多用 ${-saved}%`
          : aCalls === 0 && bCalls === 0
          ? "—"
          : "持平"}
      </div>
    </div>
  );

  return (
    <div className="bg-amber-500/5 border border-amber-500/30 rounded p-3">
      <div className="text-amber-400 text-xs font-semibold mb-2 flex items-center gap-2">
        ⚡ 最近两段对比（A · 倒数第二 → B · 最新）
        <span className="text-textSub font-normal text-[11px]">
          A: {a.label} → B: {b.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Tile title="AI 调用" av={aCalls} bv={bCalls} saved={callSaved} />
        <Tile title="Tokens" av={aTokens} bv={bTokens} saved={tokenSaved} />
        <Tile title="耗时" av={aMs} bv={bMs} saved={msSaved} unit="ms" />
      </div>
      {callSaved > 0 && (
        <div className="text-xs text-emerald-400 mt-2 font-semibold">
          ✓ B 比 A 节省了 {callSaved}% AI 调用
          {tokenSaved > 0 && <> 和 {tokenSaved}% Tokens</>}
          ——这是 LIMIT 下推/Filter 收紧带来的实测效果
        </div>
      )}
    </div>
  );
}

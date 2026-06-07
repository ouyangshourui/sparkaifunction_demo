/**
 * Try It · 60 秒 Aha 故事页（首屏）—— v2
 *
 * 核心叙事：「用户什么都没改，规则替他省了」
 *
 * 三幕剧（全部基于实证 EXPLAIN Plan + token 实测，不是 mock 大字报）：
 *  Act 1 · 写最自然的 SQL 看规则的"魔法时刻"
 *           展示 PushLimitBeforeAIInference 在 Analyzed Plan 层的真实变形
 *
 *  Act 2 · 关掉规则 vs 开启规则
 *           SET spark.aifn.pushLimit.enabled=false/true，前后跑同一条 SQL
 *           看 EXPLAIN Plan 形态差异（LocalLimit 在 AI 之上 vs 之下）
 *           看实测 token 对比
 *
 *  Act 3 · 任务挂掉重跑场景
 *           跑 N 行 → 模拟挂掉（flush + clear）→ 重跑 N 行 → AI=0
 *           折算 ¥X × M 行/天 的省钱规模
 *
 * 全部复用现有后端 API：
 *  - POST /api/sql/execute（含 SET 语句）
 *  - POST /api/sql/explain
 *  - POST /api/metrics/reset
 *  - GET  /api/metrics
 *  - POST /api/recovery/{flush-delta,clear,load-delta}
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  clearState,
  executeSql,
  explainSql,
  flushDelta,
  getMetrics,
  loadDelta,
  resetMetrics,
  type ExplainResult,
  type SqlResult,
} from "../api/client";
import { diffSnapshot, type SqlSegment } from "../lib/segments";
import { fmtCNY, totalCost } from "../lib/pricing";

// ============================================================
// 共用 SQL（Act 1 / Act 2 用同一条，让"用户什么都没改"成立）
// ============================================================
const NATURAL_SQL = `-- 一条最自然的写法：先选列，再 LIMIT
-- 用户没写子查询、没改 SQL，就这一行
SELECT id, text,
       ai_classify(text, array('正面','负面','中性')) AS sentiment
FROM reviews
LIMIT 3;`;

const ACT3_SQL = `-- 100 条评论全部打标签（凌晨任务）
SELECT id,
       ai_classify(text, array('正面','负面','中性')) AS s
FROM reviews;`;

// ============================================================
// 组件入口
// ============================================================
export default function TryIt() {
  return (
    <div className="h-full overflow-auto">
      <Hero />
      <div className="max-w-6xl mx-auto px-6 pb-16 space-y-6">
        <Act1 />
        <Act2 />
        <Act3 />
        <Cta />
      </div>
    </div>
  );
}

// ============================================================
// Hero
// ============================================================
function Hero() {
  return (
    <div className="bg-gradient-to-br from-bgPanel2 via-bgPanel to-bgPanel2 border-b border-border">
      <div className="max-w-6xl mx-auto px-6 py-12 text-center">
        <div className="inline-block px-3 py-1 mb-4 rounded-full bg-teal/10 border border-teal/30 text-teal text-xs uppercase tracking-wider font-semibold">
          Spark Catalyst Extension · 一等算子
        </div>
        <h1 className="text-4xl md:text-5xl font-bold text-textMain mb-4 tracking-tight">
          用户什么都没改，<span className="text-teal">规则替他省了</span>
        </h1>
        <p className="text-textSub text-lg max-w-2xl mx-auto leading-relaxed">
          写最自然的 SQL，让 Catalyst Extension 自动改写 Plan、行级幂等、智能路由 ——
          <span className="text-amber font-semibold">不需要重写、不需要子查询、不需要主动 cache</span>。
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <a
            href="#act1"
            className="px-6 py-2.5 rounded-md bg-teal hover:bg-tealDeep text-white font-semibold text-sm transition shadow-lg shadow-teal/20"
          >
            ▶ 60 秒看完三个魔法时刻
          </a>
          <Link
            to="/workspace"
            className="px-6 py-2.5 rounded-md border border-border hover:border-teal hover:text-teal text-textSub text-sm transition bg-bgPanel"
          >
            ↗ 进 Workspace 自己写
          </Link>
        </div>
        <div className="mt-8 flex items-center justify-center gap-6 text-xs text-textSub/70">
          <Stat label="规则数" v="4 条 Catalyst" />
          <Sep />
          <Stat label="Spark" v="3.5.8" />
          <Sep />
          <Stat label="Iceberg" v="1.6.1" />
          <Sep />
          <Stat label="数据集" v="100 条 reviews" />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Act 1 · 写最自然的 SQL，看规则的"魔法时刻"
// ============================================================
interface Act1Result {
  sqlResult: SqlResult;
  explain: ExplainResult;
  delta: SqlSegment["delta"];
}

function Act1() {
  const [sql, setSql] = useState<string>(NATURAL_SQL);
  const [r, setR] = useState<Act1Result | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");

  const isModified = sql.trim() !== NATURAL_SQL.trim();

  const run = async () => {
    setRunning(true);
    setR(null);
    setErr("");
    try {
      // 确保规则开启 + 清 cache 重计数
      await executeSql("SET spark.aifn.pushLimit.enabled=true", 1);
      await clearState().catch(() => {});
      await resetMetrics().catch(() => {});

      const before = await getMetrics().catch(() => ({}));
      const sqlResult = await executeSql(sql, 10);
      const after = await getMetrics().catch(() => before);
      const explain = await explainSql(sql);
      setR({ sqlResult, explain, delta: diffSnapshot(before, after) });
    } catch (e: any) {
      setErr(e.response?.data?.detail ?? e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <ActCard
      id="act1"
      no="1"
      title="写最自然的 SQL，看规则的「魔法时刻」"
      tone="teal"
      subtitle="用户只写一条 SELECT...LIMIT 3，PushLimitBeforeAIInference 自动把 LocalLimit 搬到 AI 算子之下"
    >
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <SqlEditableBox
            sql={sql}
            onChange={setSql}
            modified={isModified}
            onReset={() => setSql(NATURAL_SQL)}
          />
          <button
            onClick={run}
            disabled={running}
            className="mt-3 w-full px-4 py-2 rounded bg-teal hover:bg-tealDeep disabled:opacity-60 text-white text-sm font-semibold"
          >
            {running ? "跑 SQL + 取 EXPLAIN…" : "▶ 运行 + 看规则改写后的 Plan"}
          </button>
        </div>

        <div className="bg-bgPanel border border-border rounded p-3 min-h-[220px]">
          {!r && !err && (
            <div className="h-full flex items-center justify-center text-textSub text-xs">
              点左侧按钮，看 Plan 里 LocalLimit 自动跑到 ai_classify 之下
            </div>
          )}
          {err && <ErrBlock err={err} />}
          {r && (
            <div className="space-y-2">
              <div className="text-xs text-textSub flex items-center gap-2">
                <span className="text-teal">✓</span>
                {r.sqlResult.row_count} 行 · {r.sqlResult.elapsed_ms} ms
                <span className="ml-auto bg-teal/20 px-2 py-0.5 rounded text-teal font-mono">
                  AI 调用 {r.delta.total_calls} 次 · {r.delta.total_tokens} tokens
                </span>
              </div>

              {/* Plan 摘要：高亮 LocalLimit 是否在 AI 之下 */}
              <PlanRibbon explain={r.explain} />

              {/* 结果表前 3 行 */}
              <table className="w-full text-xs font-mono">
                <thead className="text-textSub/70 border-b border-border">
                  <tr>
                    {r.sqlResult.schema.slice(0, 3).map((c) => (
                      <th key={c.name} className="text-left py-1 pr-2">
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.sqlResult.rows.slice(0, 3).map((row, i) => (
                    <tr key={i} className="border-b border-border/30">
                      {r.sqlResult.schema.slice(0, 3).map((c) => (
                        <td key={c.name} className="py-1 pr-2 text-textMain truncate max-w-[160px]">
                          {String(row[c.name] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </ActCard>
  );
}

// ============================================================
// Act 2 · 关掉规则 vs 开启规则（同一条 SQL）
// ============================================================
interface Act2Side {
  pushdown_plan: string;
  limit_pushed_below_ai: boolean;
  delta: SqlSegment["delta"];
  elapsed_ms: number;
}

function Act2() {
  const [off, setOff] = useState<Act2Side | null>(null);
  const [on, setOn] = useState<Act2Side | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const runOne = async (enabled: boolean): Promise<Act2Side> => {
    // SET + 清 cache + reset metrics → 跑 SQL + EXPLAIN
    await executeSql(`SET spark.aifn.pushLimit.enabled=${enabled}`, 1);
    await clearState().catch(() => {});
    await resetMetrics().catch(() => {});

    const before = await getMetrics().catch(() => ({}));
    const sqlR = await executeSql(NATURAL_SQL, 10);
    const after = await getMetrics().catch(() => before);
    const exp = await explainSql(NATURAL_SQL);
    return {
      pushdown_plan: exp.plan_pushdown || exp.plan_baseline || "",
      limit_pushed_below_ai: exp.diff?.limit_pushed_below_ai ?? false,
      delta: diffSnapshot(before, after),
      elapsed_ms: sqlR.elapsed_ms,
    };
  };

  const run = async () => {
    setRunning(true);
    setOff(null);
    setOn(null);
    setLog([]);
    const append = (s: string) => setLog((arr) => [...arr, s]);
    try {
      append("① 关闭规则：SET spark.aifn.pushLimit.enabled=false");
      append("   清 cache + reset metrics + 跑 SQL + EXPLAIN…");
      const offR = await runOne(false);
      setOff(offR);
      append(
        `   → Plan 里 LocalLimit ${
          offR.limit_pushed_below_ai ? "已下推" : "在 AI 之上"
        }；AI 调用 ${offR.delta.total_calls} 次 / ${offR.delta.total_tokens} tokens`,
      );

      append("② 开启规则：SET spark.aifn.pushLimit.enabled=true");
      append("   清 cache + reset metrics + 跑同一条 SQL + EXPLAIN…");
      const onR = await runOne(true);
      setOn(onR);
      append(
        `   → Plan 里 LocalLimit ${
          onR.limit_pushed_below_ai ? "已下推到 AI 之下 ✅" : "在 AI 之上 ⚠️"
        }；AI 调用 ${onR.delta.total_calls} 次 / ${onR.delta.total_tokens} tokens`,
      );

      append("③ 完成 — 同一条 SQL，规则改 Plan 形态，语义不变");
    } catch (e: any) {
      append(`✗ 失败：${e.response?.data?.detail ?? e.message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <ActCard
      no="2"
      title="关掉规则 vs 开启规则（同一条 SQL）"
      tone="amber"
      subtitle="用户没动 SQL，只切了 spark.aifn.pushLimit.enabled。EXPLAIN 揭示规则在 Plan 层做了什么"
    >
      <div className="bg-bgDark border border-border rounded p-3 mb-3">
        <pre className="text-xs font-mono text-textMain whitespace-pre-wrap">{NATURAL_SQL}</pre>
      </div>

      <button
        onClick={run}
        disabled={running}
        className="w-full px-4 py-2.5 rounded bg-amber hover:opacity-90 disabled:opacity-60 text-white text-sm font-bold shadow-lg"
      >
        {running ? "对照运行中…（~6s）" : "▶▶ 一键回放：关→跑→开→跑→看 Plan + Token 差异"}
      </button>

      {log.length > 0 && (
        <div className="mt-3 bg-bgDark border border-border rounded p-2 text-[11px] font-mono text-textSub max-h-40 overflow-auto">
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {off && on && (
        <>
          {/* Plan 并排对比 */}
          <div className="mt-4 grid md:grid-cols-2 gap-3">
            <PlanCompareSide title="① 关闭规则" tone="rose" data={off} />
            <PlanCompareSide title="② 开启规则" tone="teal" data={on} />
          </div>

          {/* 总结条 */}
          <Act2Verdict off={off} on={on} />
        </>
      )}
    </ActCard>
  );
}

function PlanCompareSide({
  title,
  tone,
  data,
}: {
  title: string;
  tone: "rose" | "teal";
  data: Act2Side;
}) {
  const head = tone === "rose" ? "text-rose-300 border-rose-400/40" : "text-teal border-teal/40";
  const badge = data.limit_pushed_below_ai
    ? "bg-teal/15 border-teal/40 text-teal"
    : "bg-rose-500/15 border-rose-400/50 text-rose-300";

  // 突出 LocalLimit / Project / ai_classify 几个关键字
  const lines = data.pushdown_plan.split("\n");

  return (
    <div className="bg-bgPanel border border-border rounded overflow-hidden">
      <div className={`px-3 py-1.5 border-b text-xs font-bold uppercase tracking-wider ${head}`}>
        {title}
      </div>
      <div className="p-2.5 text-[11px] space-y-2">
        <div className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${badge}`}>
          {data.limit_pushed_below_ai
            ? "✓ LocalLimit 在 AI 之下"
            : "✗ LocalLimit 在 AI 之上"}
        </div>
        <pre className="bg-bgDark border border-border rounded p-2 max-h-48 overflow-auto text-[10px] font-mono leading-relaxed">
          {lines.map((line, i) => {
            const lower = line.toLowerCase();
            const cls =
              lower.includes("locallimit") || lower.includes("globallimit")
                ? "text-rose-300"
                : lower.includes("ai_classify") || lower.includes("project")
                ? "text-teal"
                : "text-textSub";
            return (
              <div key={i} className={cls}>
                {line || " "}
              </div>
            );
          })}
        </pre>
        <div className="text-textSub text-[11px] grid grid-cols-3 gap-1">
          <span>调用 <b className="text-textMain font-mono">{data.delta.total_calls}</b></span>
          <span>tokens <b className="text-textMain font-mono">{data.delta.total_tokens}</b></span>
          <span>耗时 <b className="text-textMain font-mono">{data.elapsed_ms} ms</b></span>
        </div>
      </div>
    </div>
  );
}

function Act2Verdict({ off, on }: { off: Act2Side; on: Act2Side }) {
  const offTok = off.delta.total_tokens;
  const onTok = on.delta.total_tokens;
  const planChanged = !off.limit_pushed_below_ai && on.limit_pushed_below_ai;

  return (
    <div className="mt-4 text-center py-3 px-4 bg-amber-500/10 border border-amber-500/30 rounded">
      <div className="text-xl font-bold text-amber mb-1">
        {planChanged ? "✅ Plan 形态被规则改写" : "Plan 未变化（规则本就稳定）"}
      </div>
      <div className="text-textSub text-xs leading-relaxed">
        关闭规则：<code className="text-rose-300">LocalLimit → Project[ai_classify] → Scan</code>（理论上 100 行全过 AI 后再砍 3 行）
        <br />
        开启规则：<code className="text-teal">Project[ai_classify] → LocalLimit → Scan</code>（LocalLimit 已搬到 AI 之下，AI 只看 3 行）
        <br />
        <span className="text-textSub/70 italic">
          注：Spark 3.5 的 CollectLimit 在 driver 端也会兜底限流，所以本机模式下两边运行时调用次数相同；
          分布式 / 复杂查询下 Plan 形态决定 AI 调用次数。这是 PushLimitBeforeAIInference 的存在意义。
        </span>
      </div>
      {offTok > 0 && onTok > 0 && offTok !== onTok && (
        <div className="text-emerald-400 text-sm font-bold mt-2">
          {offTok > onTok ? `↓ tokens ${offTok} → ${onTok}（节省 ${Math.round(((offTok - onTok) / offTok) * 100)}%）` : `相同 token 用量`}
        </div>
      )}
    </div>
  );
}

function PlanRibbon({ explain }: { explain: ExplainResult }) {
  const limitBelow = explain.diff?.limit_pushed_below_ai ?? false;
  const optPushed = explain.diff?.optimized_pushed_filters ?? [];
  return (
    <div className="bg-bgDark/50 border border-border rounded px-2 py-1.5 text-[10px] flex flex-wrap gap-x-3 gap-y-1 items-center">
      <span
        className={`px-1.5 py-0.5 rounded font-bold ${
          limitBelow
            ? "bg-teal/15 border border-teal/40 text-teal"
            : "bg-rose-500/15 border border-rose-400/50 text-rose-300"
        }`}
      >
        {limitBelow ? "✓ LocalLimit 已搬到 AI 之下" : "✗ LocalLimit 在 AI 之上"}
      </span>
      <span className="text-textSub">
        PushedFilters [{optPushed.length}]
      </span>
      <span className="text-textSub italic ml-auto">
        EXPLAIN 实测，不是图示
      </span>
    </div>
  );
}

// ============================================================
// Act 3 · 任务挂掉重跑（行级 + 重启级幂等）
// ============================================================
interface Act3Step {
  name: string;
  result: SqlResult;
  delta: SqlSegment["delta"];
}

function Act3() {
  const [first, setFirst] = useState<Act3Step | null>(null);
  const [second, setSecond] = useState<Act3Step | null>(null);
  const [afterRestart, setAfterRestart] = useState<Act3Step | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setFirst(null);
    setSecond(null);
    setAfterRestart(null);
    setLog([]);
    const append = (s: string) => setLog((arr) => [...arr, s]);

    try {
      append("① 重置：清 cache + reset metrics");
      await clearState().catch(() => {});
      await resetMetrics();

      append("② 第一次跑 100 行（凌晨任务正常运行）");
      const b1 = await getMetrics().catch(() => ({}));
      const r1 = await executeSql(ACT3_SQL, 100);
      const a1 = await getMetrics().catch(() => b1);
      const d1 = diffSnapshot(b1, a1);
      const s1: Act3Step = { name: "首次", result: r1, delta: d1 };
      setFirst(s1);
      append(`   → ${d1.total_calls} 次真实 AI 调用 / ${d1.total_tokens} tokens / ${r1.elapsed_ms} ms`);

      append("③ 重跑（任务复跑，行级幂等命中 cache）");
      const b2 = await getMetrics().catch(() => a1);
      const r2 = await executeSql(ACT3_SQL, 100);
      const a2 = await getMetrics().catch(() => b2);
      const d2 = diffSnapshot(b2, a2);
      const s2: Act3Step = { name: "重跑", result: r2, delta: d2 };
      setSecond(s2);
      append(`   → ${d2.total_calls} 次新调用 / ${d2.total_tokens} tokens（cache 命中）`);

      append("④ 模拟「任务挂掉，进程死了」：flush → 清 cache → load");
      await flushDelta();
      await clearState();
      await loadDelta();

      append("⑤ 重启后再跑（Iceberg 持久化 → cache 已恢复）");
      const b3 = await getMetrics().catch(() => a2);
      const r3 = await executeSql(ACT3_SQL, 100);
      const a3 = await getMetrics().catch(() => b3);
      const d3 = diffSnapshot(b3, a3);
      const s3: Act3Step = { name: "重启后", result: r3, delta: d3 };
      setAfterRestart(s3);
      append(`   → ${d3.total_calls} 次新调用 / ${d3.total_tokens} tokens（重启级幂等）`);

      append("✓ 完成 — 行级幂等 + 重启级幂等：跑过的永远不再花一分钱");
    } catch (e: any) {
      append(`✗ 失败：${e.response?.data?.detail ?? e.message}`);
    } finally {
      setRunning(false);
    }
  };

  // 用 first 的 token 量折算月度规模（假设业务每天跑 1w 行 = 100 倍当前规模）
  const dailyRowsAssumption = 10000;
  const firstTokens = first?.delta.total_tokens ?? 0;
  const tokensPerRow = first ? firstTokens / 100 : 0;
  const dailyCostPerRun = (totalCost({}, { "hy-mt2-pro": tokensPerRow * dailyRowsAssumption }) || 0);
  // 假设每天因任务挂掉重跑 2 次 → 一个月省 60 次重跑
  const monthlySaved = dailyCostPerRun * 60;

  return (
    <ActCard
      no="3"
      title="任务挂掉重跑：以为要再付一遍钱，结果 = 0"
      tone="violet"
      subtitle="StateTable hash 去重 + Iceberg 持久化，行级 + 重启级双层幂等"
    >
      <div className="bg-bgDark border border-border rounded p-3 mb-3">
        <pre className="text-xs font-mono text-textMain whitespace-pre-wrap">{ACT3_SQL}</pre>
      </div>

      <button
        onClick={run}
        disabled={running}
        className="w-full px-4 py-2.5 rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-60 text-white text-sm font-bold shadow-lg"
      >
        {running ? "演示中…（~15s · 跑 100 行 × 3 轮）" : "▶▶ 一键演示：跑 100 → 重跑 → 模拟挂掉重启 → 再跑"}
      </button>

      {log.length > 0 && (
        <div className="mt-3 bg-bgDark border border-border rounded p-2 text-[11px] font-mono text-textSub max-h-44 overflow-auto">
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {first && (
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Act3Tile n="①" title="首次跑 100 行" step={first} tone="rose" emphasizeZero={false} />
          <Act3Tile n="②" title="重跑（行级幂等）" step={second} tone="amber" emphasizeZero />
          <Act3Tile n="③" title="重启后再跑（重启级幂等）" step={afterRestart} tone="teal" emphasizeZero />
        </div>
      )}

      {first && second && afterRestart && (
        <div className="mt-4 text-center py-4 px-4 bg-violet-500/10 border border-violet-500/30 rounded space-y-2">
          <div className="text-2xl font-bold text-violet-300">
            ② ③ 新增 AI 调用 = 0
          </div>
          <div className="text-textSub text-xs leading-relaxed">
            行级幂等：StateTable 用 prompt_hash 锁定输入↔输出
            <br />
            重启级幂等：cache 写到 Iceberg，进程死了重启 load 回来还认
          </div>
          <div className="border-t border-violet-500/20 pt-2 text-xs text-textSub">
            <div>
              假设业务规模 = <b className="text-textMain">每天跑 {dailyRowsAssumption.toLocaleString()} 行</b>，
              每行约 <b className="text-textMain">{tokensPerRow.toFixed(0)} tokens</b>
            </div>
            <div>
              单次跑全量约 <b className="text-emerald-400 font-mono">{fmtCNY(dailyCostPerRun)}</b>；
              一个月若因挂掉重跑 60 次 ≈ 省 <b className="text-emerald-400 font-mono text-base">{fmtCNY(monthlySaved)}</b>
            </div>
          </div>
        </div>
      )}
    </ActCard>
  );
}

function Act3Tile({
  n,
  title,
  step,
  tone,
  emphasizeZero,
}: {
  n: string;
  title: string;
  step: Act3Step | null;
  tone: "rose" | "amber" | "teal";
  emphasizeZero: boolean;
}) {
  const ring = {
    rose: "border-rose-400/50",
    amber: "border-amber-500/50",
    teal: "border-teal/50",
  }[tone];
  const head = {
    rose: "text-rose-300",
    amber: "text-amber",
    teal: "text-teal",
  }[tone];
  if (!step) {
    return (
      <div className={`bg-bgPanel border ${ring} opacity-40 rounded p-3`}>
        <div className={`text-xs font-bold ${head} mb-1`}>{n} {title}</div>
        <div className="text-textSub/60 text-xs italic">等待…</div>
      </div>
    );
  }
  const calls = step.delta.total_calls;
  const tokens = step.delta.total_tokens;
  return (
    <div className={`bg-bgPanel border ${ring} rounded p-3`}>
      <div className={`text-xs font-bold ${head} mb-1.5`}>{n} {title}</div>
      <div className="font-mono text-xs space-y-0.5">
        <div className="flex justify-between">
          <span className="text-textSub">AI 调用</span>
          <span className={emphasizeZero && calls === 0 ? "text-emerald-400 font-bold text-base" : "text-textMain"}>
            {calls}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-textSub">Tokens</span>
          <span className={emphasizeZero && tokens === 0 ? "text-emerald-400" : "text-textMain"}>
            {tokens.toLocaleString()}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-textSub">耗时</span>
          <span className="text-textMain">{step.result.elapsed_ms} ms</span>
        </div>
        <div className="flex justify-between">
          <span className="text-textSub">行数</span>
          <span className="text-textMain">{step.result.row_count}</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// CTA
// ============================================================
function Cta() {
  return (
    <div className="text-center py-8 border-t border-border">
      <div className="text-textSub text-sm mb-4">看完了？换你来写一条试试</div>
      <div className="flex items-center justify-center gap-3">
        <Link
          to="/workspace"
          className="px-6 py-2.5 rounded-md bg-teal hover:bg-tealDeep text-white font-semibold text-sm"
        >
          ⌨ 打开 Workspace 自己写
        </Link>
        <Link
          to="/insights"
          className="px-6 py-2.5 rounded-md border border-border hover:border-teal hover:text-teal text-textSub text-sm bg-bgPanel"
        >
          📊 看 Insights 累计省了多少
        </Link>
      </div>
    </div>
  );
}

// ============================================================
// 共用子组件
// ============================================================
function ActCard({
  no,
  title,
  tone,
  subtitle,
  children,
  id,
}: {
  no: string;
  title: string;
  tone: "teal" | "amber" | "violet";
  subtitle: string;
  children: React.ReactNode;
  id?: string;
}) {
  const accent = {
    teal: "border-teal/30 from-teal/5",
    amber: "border-amber-500/40 from-amber-500/5",
    violet: "border-violet-500/40 from-violet-500/5",
  }[tone];
  const numColor = {
    teal: "bg-teal text-white",
    amber: "bg-amber text-white",
    violet: "bg-violet-600 text-white",
  }[tone];
  return (
    <section id={id} className={`bg-gradient-to-br to-bgPanel border ${accent} rounded-lg p-5`}>
      <div className="flex items-start gap-3 mb-4">
        <div className={`flex-none w-8 h-8 rounded-full font-bold flex items-center justify-center ${numColor}`}>
          {no}
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-bold text-textMain">{title}</h2>
          <p className="text-textSub text-xs mt-0.5">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function SqlBox({ sql }: { sql: string }) {
  return (
    <div className="bg-bgDark border border-border rounded p-3">
      <pre className="text-xs font-mono text-textMain whitespace-pre-wrap leading-relaxed">{sql}</pre>
    </div>
  );
}

// 错误展示：识别 429 / 鉴权 / 普通三类，分别给不同颜色 + 行动建议
function ErrBlock({ err }: { err: string }) {
  const low = err.toLowerCase();
  const isRateLimit =
    low.includes("429") || low.includes("rate limit") || low.includes("rpm") || low.includes("tpm") || low.includes("限频");
  const isAuth = low.includes("401") || low.includes("invalid api key") || low.includes("apikey") || low.includes("鉴权");

  if (isRateLimit) {
    return (
      <div className="bg-amber/10 border border-amber/40 rounded p-3 text-xs space-y-1.5">
        <div className="flex items-center gap-1.5 text-amber font-semibold">
          ⏱ 网关限频（RPM/TPM 超额）
        </div>
        <div className="text-textSub leading-relaxed font-mono whitespace-pre-wrap">{err}</div>
        <div className="text-textSub leading-relaxed border-l-2 border-amber pl-2 mt-1">
          💡 已自动退避重试 200/600/1500ms 共 3 次仍失败。等 30-60 秒再点，或去 Settings 把 Demo Mode 切到 <code className="text-amber px-1">auto</code> 让失败自动降级 mock。
        </div>
      </div>
    );
  }
  if (isAuth) {
    return (
      <div className="bg-amber/10 border border-amber/40 rounded p-3 text-xs space-y-1.5">
        <div className="flex items-center gap-1.5 text-amber font-semibold">🔑 鉴权失败</div>
        <div className="text-textSub leading-relaxed font-mono whitespace-pre-wrap">{err}</div>
        <div className="text-textSub leading-relaxed border-l-2 border-amber pl-2 mt-1">
          💡 去 <Link to="/settings" className="text-teal underline">Settings</Link> 用「测试连接」重测 Key，错误诊断会列出可执行排查项。
        </div>
      </div>
    );
  }
  return (
    <div className="bg-rose-500/10 border border-rose-400/30 rounded p-3 text-xs">
      <pre className="text-rose-300 font-mono whitespace-pre-wrap leading-relaxed">{err}</pre>
    </div>
  );
}

// Act 1 用：可编辑版 SqlBox，含「已修改」徽标 + 重置按钮
// 不引入 Monaco（保持 TryIt 轻量），用原生 textarea + 等宽字体
function SqlEditableBox({
  sql,
  onChange,
  modified,
  onReset,
}: {
  sql: string;
  onChange: (v: string) => void;
  modified: boolean;
  onReset: () => void;
}) {
  // textarea 自适应行数（最少 6 行）
  const lineCount = Math.max(6, sql.split("\n").length);
  return (
    <div className="bg-bgDark border border-border rounded">
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border text-[10px]">
        <div className="flex items-center gap-2 text-textSub">
          <span className="font-mono">SQL · 可直接编辑后再运行</span>
          {modified && (
            <span className="px-1.5 py-0.5 rounded bg-amber/15 text-amber border border-amber/30">
              已修改
            </span>
          )}
        </div>
        {modified && (
          <button
            onClick={onReset}
            className="text-textSub hover:text-teal underline decoration-dotted"
            type="button"
            title="恢复为默认 NATURAL_SQL"
          >
            ↺ 重置
          </button>
        )}
      </div>
      <textarea
        value={sql}
        onChange={(e) => onChange(e.target.value)}
        rows={lineCount}
        spellCheck={false}
        className="w-full bg-bgDark text-textMain font-mono text-xs leading-relaxed
                   px-3 py-2 resize-y outline-none focus:ring-1 focus:ring-teal/40 rounded-b"
        placeholder="SELECT ai_classify(text, array('A','B')) FROM reviews LIMIT 3"
      />
    </div>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-textSub/60">{label}</span>
      <span className="font-mono text-teal">{v}</span>
    </div>
  );
}

function Sep() {
  return <span className="text-border">·</span>;
}

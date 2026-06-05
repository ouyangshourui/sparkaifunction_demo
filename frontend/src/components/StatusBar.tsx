/**
 * 顶部全局状态条 —— 跨页常驻
 *
 * 显示：
 *  - Spark 是否活着 + 版本
 *  - ApiKey 是否配置 + 当前 base/model
 *  - Token 用量 + 预算进度（接近 80% 橙色，95% 红色）
 *  - Spark UI 直达链接（4040）
 *
 * 设计目的：用户在任意页面都能 1 秒判断「这个 demo 现在是真活的吗」，
 * 取代原来散落在 Settings/Monitor 的 badge。
 */
import { useEffect, useState } from "react";
import {
  getCredentials,
  getMetrics,
  type CredentialsView,
  type MetricsSnapshot,
} from "../api/client";
import { fmtCNY, totalCost } from "../lib/pricing";

interface Health {
  status: string;
  spark_version: string;
}

export default function StatusBar({ sparkUiUrl }: { sparkUiUrl: string | null }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [cred, setCred] = useState<CredentialsView | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot>({});

  useEffect(() => {
    const tick = async () => {
      try {
        const [h, c, m] = await Promise.all([
          fetch("/api/health").then((r) => (r.ok ? r.json() : null)),
          getCredentials().catch(() => null),
          getMetrics().catch(() => ({} as MetricsSnapshot)),
        ]);
        setHealth(h);
        setCred(c);
        setMetrics(m);
      } catch {
        /* swallow */
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);

  const tokens = metrics.total_tokens ?? 0;
  const budget = metrics.token_budget ?? 1_000_000;
  const usePct = budget ? Math.min(100, (tokens / budget) * 100) : 0;
  const cost = totalCost(metrics.prompt_tokens_by_model, metrics.completion_tokens_by_model);

  const tokenTone =
    metrics.budget_exhausted || usePct >= 95
      ? "bg-red-500"
      : usePct >= 80
      ? "bg-amber-500"
      : "bg-teal";

  const sparkAlive = !!health && health.status === "ok";
  const apiOk = !!cred?.configured;

  return (
    <div className="bg-bgPanel2 border-b border-border px-4 py-1 flex items-center gap-3 text-xs text-textSub">
      {/* Spark 状态 */}
      <Pill
        tone={sparkAlive ? "ok" : "err"}
        title={sparkAlive ? `Spark ${health?.spark_version} 在跑` : "Spark 进程未响应"}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${sparkAlive ? "bg-teal" : "bg-red-500"} ${sparkAlive ? "animate-pulse" : ""}`} />
        Spark {health?.spark_version || "—"}
      </Pill>

      {/* API 凭证状态 */}
      <Pill
        tone={apiOk ? "ok" : "warn"}
        title={
          apiOk
            ? `已配置 · 小模型 ${cred?.small_model} · 大模型 ${cred?.large_model}`
            : "未配置 ApiKey · demo_mode=auto 时自动 mock"
        }
      >
        <span>{apiOk ? "API ✓" : "API · mock"}</span>
        {cred && (
          <span className="text-textSub/70 ml-1 font-mono">
            {(cred.base_url || "").replace(/^https?:\/\//, "").split("/")[0]}
          </span>
        )}
      </Pill>

      {/* Token 用量 + 预算进度 */}
      <div className="flex items-center gap-2 bg-bgPanel border border-border rounded px-2 py-0.5" title={`已用 ${usePct.toFixed(1)}% 预算 ${budget.toLocaleString()} tokens`}>
        <span className="font-mono text-textMain">
          {tokens.toLocaleString()} <span className="text-textSub/60">tok</span>
        </span>
        <div className="w-16 h-1.5 bg-bgPanel2 rounded overflow-hidden">
          <div className={`h-full ${tokenTone} transition-all`} style={{ width: `${usePct}%` }} />
        </div>
        <span className="text-emerald-400 font-mono">{fmtCNY(cost)}</span>
      </div>

      {/* 总调用次数 */}
      {(metrics.total_calls ?? 0) > 0 && (
        <Pill tone="info" title="累计 AI 调用次数（全 SparkSession）">
          <span className="font-mono text-textMain">{(metrics.total_calls ?? 0).toLocaleString()}</span>
          <span className="text-textSub/60 ml-1">calls</span>
        </Pill>
      )}

      {/* Spark UI 链接 */}
      <a
        href={sparkUiUrl || "http://127.0.0.1:4040"}
        target="_blank"
        rel="noreferrer"
        className="ml-auto px-2 py-0.5 rounded border border-border hover:border-teal hover:text-teal text-textSub flex items-center gap-1"
        title="打开 Spark UI"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
        Spark UI
      </a>
    </div>
  );
}

function Pill({
  tone,
  title,
  children,
}: {
  tone: "ok" | "err" | "warn" | "info";
  title?: string;
  children: React.ReactNode;
}) {
  const cls = {
    ok: "border-teal/50 text-teal bg-teal/5",
    err: "border-red-500/50 text-red-300 bg-red-500/10",
    warn: "border-amber-500/50 text-amber bg-amber-500/10",
    info: "border-border text-textSub bg-bgPanel/50",
  }[tone];
  return (
    <div className={`px-2 py-0.5 rounded border ${cls} flex items-center gap-1.5 font-medium`} title={title}>
      {children}
    </div>
  );
}

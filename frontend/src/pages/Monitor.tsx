import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getMetrics } from "../api/client";

interface Metrics {
  total_tokens?: number;
  token_budget?: number;
  calls_by_model?: Record<string, number>;
  routed_distribution?: Record<string, number>;
  budget_exhausted?: boolean;
}

export default function Monitor() {
  const [m, setM] = useState<Metrics>({});

  useEffect(() => {
    const tick = () => getMetrics().then(setM).catch(() => {});
    tick();
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, []);

  const tokens = m.total_tokens ?? 0;
  const budget = m.token_budget ?? 1_000_000;
  const usePct = budget ? Math.min(100, (tokens / budget) * 100) : 0;

  const pieData = Object.entries(m.routed_distribution ?? {}).map(([n, v]) => ({
    name: n,
    value: v,
  }));

  const barData = Object.entries(m.calls_by_model ?? {});

  return (
    <div className="h-full grid grid-cols-3 gap-3 p-3 overflow-auto">
      <Card title="Token 使用">
        <div className="text-3xl text-teal font-bold">{tokens.toLocaleString()}</div>
        <div className="text-textSub text-xs mt-1">
          预算 {budget.toLocaleString()} · 已用 {usePct.toFixed(1)}%
        </div>
        <div className="mt-3 h-2 bg-bgPanel2 rounded overflow-hidden">
          <div
            className={`h-full ${m.budget_exhausted ? "bg-red-500" : "bg-teal"}`}
            style={{ width: `${usePct}%` }}
          />
        </div>
      </Card>

      <Card title="路由分布">
        <ReactECharts
          style={{ height: 200 }}
          option={{
            tooltip: { trigger: "item" },
            legend: { textStyle: { color: "#8b949e" } },
            series: [
              {
                type: "pie",
                radius: ["40%", "70%"],
                data: pieData,
                label: { color: "#e6edf3" },
              },
            ],
            color: ["#0d9488", "#f59e0b", "#dc2626", "#3b82f6"],
          }}
        />
      </Card>

      <Card title="模型调用次数">
        <ReactECharts
          style={{ height: 200 }}
          option={{
            tooltip: {},
            xAxis: { type: "category", data: barData.map((d) => d[0]),
                     axisLabel: { color: "#8b949e" } },
            yAxis: { type: "value", axisLabel: { color: "#8b949e" } },
            series: [
              { type: "bar", data: barData.map((d) => d[1]), itemStyle: { color: "#0d9488" } },
            ],
            grid: { top: 10, right: 10, bottom: 30, left: 40 },
          }}
        />
      </Card>

      <Card title="预算告警" wide>
        {m.budget_exhausted ? (
          <div className="text-red-400 font-bold">
            ⚠️ Token 预算已耗尽 — 优化器将自动降级到只跑 small 模型
          </div>
        ) : (
          <div className="text-textSub">预算正常，未触发降级</div>
        )}
      </Card>

      <Card title="原始指标 JSON" wide colSpan={2}>
        <pre className="text-xs text-textSub whitespace-pre-wrap font-mono">
          {JSON.stringify(m, null, 2)}
        </pre>
      </Card>
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
      className={`bg-bgPanel border border-border rounded p-4 ${
        wide ? "col-span-3" : ""
      }`}
      style={colSpan ? { gridColumn: `span ${colSpan}` } : undefined}
    >
      <div className="text-teal text-xs uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  StateView,
  clearState,
  flushDelta,
  listState,
  loadDelta,
  replay,
} from "../api/client";

const empty: StateView = {
  cached_count: 0,
  audit_pending: 0,
  persisted_count: 0,
  table: "local.default.ai_inference_state",
  sample: [],
};

export default function Recovery() {
  const [state, setState] = useState<StateView>(empty);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    listState()
      .then(setState)
      .catch((e) => setMsg(`刷新失败：${e?.message ?? e}`));

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  const wrap = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg("");
    try {
      const m = await fn();
      setMsg(m);
      await refresh();
    } catch (e: any) {
      setMsg(`✗ ${e?.response?.data?.detail ?? e?.message ?? "失败"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full p-4 overflow-auto space-y-4">
      {/* —— 指标条 —— */}
      <div className="grid grid-cols-3 gap-4">
        <Card title="Executor 内存缓存" value={state.cached_count} hint="prompt_hash → output" tone="teal" />
        <Card
          title="待 flush 的 Audit 条数"
          value={state.audit_pending}
          hint="本批新成功调用，未落盘"
          tone="amber"
        />
        <Card
          title="Iceberg 已持久化条数"
          value={state.persisted_count < 0 ? "—" : state.persisted_count}
          hint={state.table}
          tone="purple"
        />
      </div>

      {/* —— 操作面板 —— */}
      <div className="bg-bgPanel border border-border rounded p-4">
        <div className="text-teal text-sm uppercase tracking-wider mb-3">
          状态恢复操作
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Btn
            disabled={busy}
            onClick={() =>
              wrap(async () => {
                const r = await flushDelta();
                return `✓ Flush：${r.flushed} 条 audit → ${r.table}`;
              })
            }
            tone="teal"
          >
            ⇩ Flush 到 Iceberg
          </Btn>
          <Btn
            disabled={busy}
            onClick={() =>
              wrap(async () => {
                const r = await loadDelta();
                return `✓ Load：从 ${r.table} 加载 ${r.loaded} 条到 cache`;
              })
            }
            tone="teal"
          >
            ⇧ 从 Iceberg Load
          </Btn>
          <Btn
            disabled={busy}
            onClick={() =>
              wrap(async () => {
                const r = await clearState();
                return `✓ 已清空 ${r.cleared} 条 cache（Iceberg 数据保留）`;
              })
            }
            tone="amber"
          >
            ✕ 清空 cache
          </Btn>
          <Btn
            disabled={busy}
            onClick={() =>
              wrap(async () => {
                const r = await replay();
                return `✓ ${r.message}`;
              })
            }
            tone="purple"
          >
            ▶ Replay (Flush→Clear→Load)
          </Btn>
          <span className={`text-sm self-center ml-2 ${msg.startsWith("✗") ? "text-red-400" : "text-textSub"}`}>
            {busy ? "执行中…" : msg}
          </span>
        </div>
      </div>

      {/* —— 缓存样例 —— */}
      <div className="bg-bgPanel border border-border rounded p-4">
        <div className="text-teal text-sm uppercase tracking-wider mb-2">
          Cache 样例（最多 20 条）
        </div>
        {state.sample.length === 0 ? (
          <div className="text-textSub text-sm">
            暂无缓存。先到 Workbench 跑一条 ai_classify / ai_extract，再回来这里看 prompt_hash 增长。
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
              {state.sample.map((e, i) => (
                <tr key={i} className="border-b border-border/40 hover:bg-bgPanel2">
                  <td className="py-1 text-amber">{e.hash}</td>
                  <td className="py-1 text-textMain">{e.preview}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* —— 演示步骤 —— */}
      <div className="bg-bgPanel border border-border rounded p-4">
        <div className="text-teal text-sm uppercase tracking-wider mb-2">演示步骤（行级幂等 / 重启恢复）</div>
        <ol className="text-textMain text-sm space-y-1.5 list-decimal list-inside">
          <li>Workbench 跑 Sample 1（ai_classify 5 行）→ Monitor token 增加；本页 cached_count = 5、audit_pending = 5</li>
          <li>原样再跑一次相同 SQL → <b>Monitor token 不再增长</b>，cache 命中（路由统计里 <code className="text-amber">cache_hit</code> 增加）</li>
          <li>点「⇩ Flush 到 Iceberg」→ audit_pending 归零，persisted_count 增加</li>
          <li>点「✕ 清空 cache」→ cached_count = 0；再跑相同 SQL → <b>token 重新增长</b>（cache 已没了）</li>
          <li>再点「⇧ 从 Iceberg Load」→ cached_count 恢复；再跑相同 SQL → <b>token 不再增长</b>（重启级幂等已演示）</li>
          <li>「▶ Replay」= 上述 Flush→Clear→Load 一键</li>
        </ol>
      </div>
    </div>
  );
}

function Card(props: {
  title: string;
  value: number | string;
  hint: string;
  tone: "teal" | "amber" | "purple";
}) {
  const colorMap = {
    teal: "text-teal",
    amber: "text-amber",
    purple: "text-purple-400",
  };
  return (
    <div className="bg-bgPanel border border-border rounded p-4">
      <div className="text-textSub text-xs uppercase tracking-wider mb-1">{props.title}</div>
      <div className={`text-3xl font-mono ${colorMap[props.tone]}`}>{props.value}</div>
      <div className="text-textSub text-xs mt-1">{props.hint}</div>
    </div>
  );
}

function Btn(props: {
  onClick: () => void;
  children: React.ReactNode;
  tone: "teal" | "amber" | "purple";
  disabled?: boolean;
}) {
  const tone = {
    teal: "bg-teal text-white hover:opacity-90",
    amber: "bg-amber text-bgDark hover:opacity-90 font-semibold",
    purple: "bg-purple-500 text-white hover:opacity-90",
  }[props.tone];
  return (
    <button
      disabled={props.disabled}
      onClick={props.onClick}
      className={`px-3 py-1.5 rounded text-sm transition disabled:opacity-50 disabled:cursor-not-allowed ${tone}`}
    >
      {props.children}
    </button>
  );
}

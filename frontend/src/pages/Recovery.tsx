import { useEffect, useState } from "react";
import { clearState, listState, replay } from "../api/client";

export default function Recovery() {
  const [state, setState] = useState<any>({});
  const [msg, setMsg] = useState("");

  const refresh = () => listState().then(setState).catch(() => {});
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="h-full p-4 overflow-auto">
      <div className="bg-bgPanel border border-border rounded p-4 mb-4">
        <div className="text-teal text-sm uppercase tracking-wider mb-2">
          行级状态 · 幂等缓存
        </div>
        <div className="text-textMain mb-3">
          已缓存条目：<span className="text-amber font-mono">{state.cached_count ?? 0}</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              const r = await replay();
              setMsg(r.message);
            }}
            className="px-3 py-1.5 bg-teal text-white rounded text-sm"
          >
            ▶ Replay
          </button>
          <button
            onClick={async () => {
              const r = await clearState();
              setMsg(`已清空 ${r.cleared} 条缓存`);
              refresh();
            }}
            className="px-3 py-1.5 bg-amber text-bgDark rounded text-sm font-semibold"
          >
            清空缓存
          </button>
          <span className="text-textSub text-sm self-center">{msg}</span>
        </div>
      </div>

      <div className="bg-bgPanel border border-border rounded p-4">
        <div className="text-teal text-sm uppercase tracking-wider mb-2">演示步骤</div>
        <ol className="text-textMain text-sm space-y-2 list-decimal list-inside">
          <li>Workbench 跑「样例 1」情感分类 → Monitor 看到 token 增长</li>
          <li>这里点「清空缓存」→ Monitor token 不变，缓存归零</li>
          <li>再跑一次相同 SQL → Monitor token 再次增长（无幂等）</li>
          <li>不清空缓存，再跑相同 SQL → Monitor token 不增长（命中 prompt_hash）</li>
          <li>故意把 HUNYUAN_API_KEY 改错，跑任务 → 看到 FAILED 行</li>
          <li>改回正确 Key → 在 Workbench 重新提交相同 SQL → 失败行重跑成功，已成功的不重复扣费</li>
        </ol>
      </div>
    </div>
  );
}

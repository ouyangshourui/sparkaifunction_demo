import type { PlanNode } from "../api/client";

const STYLE: Record<
  PlanNode["category"],
  { bg: string; border: string; label: string; chip: string }
> = {
  ai: {
    bg: "bg-sky-500/15",
    border: "border-sky-400/60",
    label: "text-sky-300",
    chip: "bg-sky-500/20 text-sky-200",
  },
  scan: {
    bg: "bg-purple-500/15",
    border: "border-purple-400/60",
    label: "text-purple-300",
    chip: "bg-purple-500/20 text-purple-200",
  },
  filter: {
    bg: "bg-amber-500/15",
    border: "border-amber-400/60",
    label: "text-amber-300",
    chip: "bg-amber-500/20 text-amber-200",
  },
  project: {
    bg: "bg-emerald-500/10",
    border: "border-emerald-400/40",
    label: "text-emerald-300",
    chip: "bg-emerald-500/20 text-emerald-200",
  },
  limit: {
    bg: "bg-rose-500/10",
    border: "border-rose-400/40",
    label: "text-rose-300",
    chip: "bg-rose-500/20 text-rose-200",
  },
  shuffle: {
    bg: "bg-indigo-500/10",
    border: "border-indigo-400/40",
    label: "text-indigo-300",
    chip: "bg-indigo-500/20 text-indigo-200",
  },
  other: {
    bg: "bg-neutral-500/10",
    border: "border-neutral-500/40",
    label: "text-neutral-300",
    chip: "bg-neutral-600/40 text-neutral-200",
  },
};

const CATEGORY_LABEL: Record<PlanNode["category"], string> = {
  ai: "AI 推理",
  scan: "数据源扫描",
  filter: "过滤",
  project: "投影",
  limit: "限制",
  shuffle: "Shuffle",
  other: "算子",
};

function NodeCard({ node }: { node: PlanNode }) {
  const style = STYLE[node.category] ?? STYLE.other;
  const pushed = node.pushedFilters ?? [];
  const runtime = node.runtimeFilters ?? [];
  const aiExprs = node.aiExpressions ?? [];

  return (
    <div className={`rounded-md border ${style.border} ${style.bg} px-3 py-2 min-w-[260px]`}>
      <div className="flex items-center gap-2">
        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${style.chip}`}>
          {CATEGORY_LABEL[node.category]}
        </span>
        <span className={`font-mono text-sm font-semibold ${style.label}`}>{node.name}</span>
        {node.table && (
          <span className="text-[11px] font-mono text-textSub">{node.table}</span>
        )}
      </div>

      {aiExprs.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          <span className="text-[10px] uppercase text-sky-300/90 mr-1 mt-0.5">
            ⚡ AI 表达式
          </span>
          {aiExprs.map((e, i) => (
            <span
              key={i}
              className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-sky-500/25 text-sky-100 border border-sky-400/40 max-w-full break-all"
              title={e}
            >
              {e}
            </span>
          ))}
        </div>
      )}

      {node.condition && (
        <div className="mt-1.5 text-[11px] font-mono text-amber-200/90">
          condition: {node.condition}
        </div>
      )}

      {pushed.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          <span className="text-[10px] uppercase text-emerald-300/80 mr-1 mt-0.5">
            ✓ PushedFilters
          </span>
          {pushed.map((f, i) => (
            <span
              key={i}
              className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/25 text-emerald-100 border border-emerald-400/40"
            >
              {f}
            </span>
          ))}
        </div>
      )}

      {runtime.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          <span className="text-[10px] uppercase text-cyan-300/80 mr-1 mt-0.5">
            RuntimeFilters
          </span>
          {runtime.map((f, i) => (
            <span
              key={i}
              className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/25 text-cyan-100 border border-cyan-400/40"
            >
              {f}
            </span>
          ))}
        </div>
      )}

      {node.output && node.output.length > 0 && (
        <div className="mt-1 text-[10px] text-textSub font-mono truncate">
          output: [{node.output.slice(0, 5).join(", ")}
          {node.output.length > 5 ? ", …" : ""}]
        </div>
      )}
    </div>
  );
}

function TreeNode({ node }: { node: PlanNode }) {
  return (
    <div className="flex flex-col items-center">
      <NodeCard node={node} />
      {node.children.length > 0 && (
        <>
          <div className="w-px h-4 bg-border" />
          <div className="flex gap-6 items-start relative">
            {node.children.length > 1 && (
              <div
                className="absolute top-0 left-0 right-0 h-px bg-border"
                style={{ marginLeft: "20%", marginRight: "20%" }}
              />
            )}
            {node.children.map((child, i) => (
              <div key={i} className="flex flex-col items-center">
                {node.children.length > 1 && <div className="w-px h-4 bg-border" />}
                <TreeNode node={child} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-border bg-bgPanel2 text-[10px]">
      {(Object.keys(STYLE) as PlanNode["category"][]).map((cat) => (
        <span
          key={cat}
          className={`px-1.5 py-0.5 rounded border ${STYLE[cat].border} ${STYLE[cat].bg} ${STYLE[cat].label}`}
        >
          {CATEGORY_LABEL[cat]}
        </span>
      ))}
      <span className="ml-auto text-textSub">
        提示：绿色 PushedFilters 说明谓词已下推到 Scan
      </span>
    </div>
  );
}

export default function PlanTree({ tree }: { tree: PlanNode | null }) {
  if (!tree) {
    return (
      <div className="flex-1 flex items-center justify-center text-textSub text-xs">
        点击 EXPLAIN 查看图形化物理计划
      </div>
    );
  }
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Legend />
      <div className="flex-1 overflow-auto p-4">
        <TreeNode node={tree} />
      </div>
    </div>
  );
}

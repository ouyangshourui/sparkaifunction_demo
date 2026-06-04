import { useState } from "react";
import SqlEditor from "../components/SqlEditor";
import ResultTable from "../components/ResultTable";
import { executeSql, explainSql, type SqlResult } from "../api/client";

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
    sql: `-- DDL 注册带 cascade router 的 AI 函数\nCREATE OR REPLACE AI FUNCTION review_tag(text STRING)\nRETURNS STRING\nUSING MODEL 'cascade(small=hunyuan-lite, large=hunyuan-pro, threshold=0.85)'\nWITH PROMPT '请用一个词标注情感：{text}'\nOPTIONS (batch_max_size='16');\n\nSELECT id, text, review_tag(text) AS tag\nFROM reviews\nLIMIT 20;`,
  },
];

export default function Workbench() {
  const [sql, setSql] = useState(SAMPLES[0].sql);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [plan, setPlan] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    setLoading(true);
    setErr("");
    setResult(null);
    try {
      const r = await executeSql(sql, 100);
      setResult(r);
    } catch (e: any) {
      setErr(e.response?.data?.detail ?? e.message);
    } finally {
      setLoading(false);
    }
  };

  const showPlan = async () => {
    try {
      const p = await explainSql(sql);
      setPlan(p.plan);
    } catch (e: any) {
      setErr(e.message);
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

        <div className="grid grid-cols-2 gap-2">
          <div className="bg-bgPanel border border-border rounded overflow-hidden">
            <div className="px-3 py-1.5 text-xs uppercase text-textSub border-b border-border bg-bgPanel2">
              Result {err && <span className="text-red-400 ml-2">{err}</span>}
            </div>
            <ResultTable data={result} />
          </div>
          <div className="bg-bgPanel border border-border rounded overflow-hidden flex flex-col">
            <div className="px-3 py-1.5 text-xs uppercase text-textSub border-b border-border bg-bgPanel2">
              Physical Plan
            </div>
            <pre className="flex-1 overflow-auto p-3 text-xs text-textMain font-mono whitespace-pre">
              {plan || "点击 EXPLAIN 查看物理计划，应能看到 AIInferenceExec 节点和谓词下推后的 Filter 位置"}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}

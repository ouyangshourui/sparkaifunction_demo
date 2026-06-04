import type { SqlResult } from "../api/client";

export default function ResultTable({ data }: { data: SqlResult | null }) {
  if (!data) return <div className="text-textSub p-4 text-sm">运行 SQL 后这里会出结果</div>;
  if (data.rows.length === 0)
    return <div className="text-textSub p-4 text-sm">空结果（耗时 {data.elapsed_ms} ms）</div>;
  return (
    <div className="overflow-auto h-full text-xs">
      <table className="w-full">
        <thead className="sticky top-0 bg-bgPanel2">
          <tr>
            {data.schema.map((c) => (
              <th key={c.name} className="text-left px-3 py-2 border-b border-border">
                <div className="text-teal font-semibold">{c.name}</div>
                <div className="text-textSub font-normal">{c.type}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr
              key={i}
              className={`hover:bg-bgPanel2 ${i % 2 ? "bg-bgPanel" : ""}`}
            >
              {data.schema.map((c) => (
                <td key={c.name} className="px-3 py-1.5 border-b border-border align-top">
                  {String(r[c.name] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { useEffect, useState } from "react";
import { listFunctions, createFunction } from "../api/client";

export default function Functions() {
  const [list, setList] = useState<{ name: string }[]>([]);
  const [form, setForm] = useState({
    name: "review_tag",
    return_type: "STRING",
    model: "cascade(small=hy-mt2-pro, large=hy3-preview, threshold=0.85)",
    prompt: "请用一个词标注情感：{text}",
  });
  const [msg, setMsg] = useState("");

  const refresh = () => listFunctions().then(setList);
  useEffect(() => {
    refresh();
  }, []);

  const submit = async () => {
    setMsg("");
    try {
      await createFunction({
        ...form,
        params: [{ col: "text", type: "STRING" }],
        options: { batch_max_size: "16" },
      });
      setMsg("✓ 注册成功");
      refresh();
    } catch (e: any) {
      setMsg(e.response?.data?.detail ?? e.message);
    }
  };

  return (
    <div className="h-full grid grid-cols-2 gap-3 p-3">
      <div className="bg-bgPanel border border-border rounded p-4">
        <div className="text-teal text-sm uppercase tracking-wider mb-3">
          注册 AI Function
        </div>
        {[
          { k: "name", label: "函数名" },
          { k: "return_type", label: "返回类型" },
          { k: "model", label: "模型 / 路由" },
          { k: "prompt", label: "Prompt 模板（{col} 占位）" },
        ].map((f) => (
          <div key={f.k} className="mb-3">
            <div className="text-textSub text-xs mb-1">{f.label}</div>
            <input
              className="w-full bg-bgPanel2 border border-border rounded px-2 py-1.5 text-sm text-textMain"
              value={(form as any)[f.k]}
              onChange={(e) => setForm({ ...form, [f.k]: e.target.value })}
            />
          </div>
        ))}
        <button
          onClick={submit}
          className="px-4 py-1.5 rounded bg-teal hover:bg-tealDeep text-white text-sm font-semibold"
        >
          CREATE AI FUNCTION
        </button>
        <span className="ml-3 text-amber text-xs">{msg}</span>
      </div>

      <div className="bg-bgPanel border border-border rounded p-4 overflow-auto">
        <div className="text-teal text-sm uppercase tracking-wider mb-3">已注册函数</div>
        <table className="w-full text-sm">
          <thead className="text-textSub text-xs">
            <tr>
              <th className="text-left py-1.5 border-b border-border">Name</th>
            </tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.name} className="hover:bg-bgPanel2">
                <td className="py-1.5 border-b border-border text-textMain font-mono">
                  {f.name}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  CredentialsPayload,
  CredentialsView,
  TestResponse,
  getCredentials,
  saveCredentials,
  testCredentials,
} from "../api/client";

const DEMO_OPTIONS = [
  { v: "auto", label: "auto（推荐：失败自动降级 mock）" },
  { v: "false", label: "false（严格模式：必须真实 API）" },
  { v: "true", label: "true（强制 mock，离线演示）" },
];

const BASE_PRESETS: { v: string; label: string }[] = [
  { v: "https://tokenhub.tencentmaas.com/v1", label: "腾讯云 TokenHub" },
  { v: "https://api.hunyuan.cloud.tencent.com/v1", label: "腾讯混元（OpenAI 兼容）" },
  { v: "https://api.deepseek.com/v1", label: "DeepSeek" },
  { v: "https://api.openai.com/v1", label: "OpenAI" },
];

// 与后端 models_catalog 保持一致；UI 显示 label，请求发 id
const MODEL_PRESETS = {
  large: [
    { id: "hy3-preview", label: "Hy3 Preview" },
    { id: "hy-mt2-pro", label: "Hy-MT2-Pro" },
    { id: "minimax-m3", label: "MiniMax M3" },
  ],
  small: [
    { id: "hy-mt2-pro", label: "Hy-MT2-Pro" },
    { id: "hy3-preview", label: "Hy3 Preview" },
    { id: "minimax-m3", label: "MiniMax M3" },
  ],
};

const initial: CredentialsPayload = {
  api_key: "",
  base_url: "https://tokenhub.tencentmaas.com/v1",
  small_model: "hy-mt2-pro",
  large_model: "hy3-preview",
  demo_mode: "auto",
};

export default function Settings() {
  const [view, setView] = useState<CredentialsView | null>(null);
  const [form, setForm] = useState<CredentialsPayload>(initial);
  const [test, setTest] = useState<TestResponse | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const refresh = async () => {
    try {
      const v = await getCredentials();
      setView(v);
      setForm((f) => ({
        ...f,
        // 不回填 api_key，避免明文回传；用户重新输入
        base_url: v.base_url || f.base_url,
        small_model: v.small_model || f.small_model,
        large_model: v.large_model || f.large_model,
        demo_mode: v.demo_mode || f.demo_mode,
      }));
    } catch (e: any) {
      setMsg({ kind: "err", text: e.message });
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const set = (k: keyof CredentialsPayload, v: string) =>
    setForm({ ...form, [k]: v });

  const onSave = async () => {
    if (!form.api_key) {
      setMsg({ kind: "err", text: "ApiKey 不能为空" });
      return;
    }
    setMsg(null);
    setBusy("save");
    try {
      const r = await saveCredentials(form);
      setMsg({
        kind: "ok",
        text: `✓ 已保存到 .env，Spark ${r.spark_restarted ? "已重启" : "未重启"}，AI Function 下次执行即走真实 API`,
      });
      await refresh();
    } catch (e: any) {
      setMsg({
        kind: "err",
        text: e.response?.data?.detail ?? e.message,
      });
    } finally {
      setBusy("");
    }
  };

  const onTest = async () => {
    if (!form.api_key) {
      setMsg({ kind: "err", text: "请先填入 ApiKey 再测试" });
      return;
    }
    setMsg(null);
    setBusy("test");
    setTest(null);
    try {
      const r = await testCredentials(form);
      setTest(r);
      if (r.ok) {
        setMsg({
          kind: "ok",
          text: `✓ 真实调用成功（${r.elapsed_ms} ms）id=${r.request_id ?? "-"}`,
        });
      } else {
        setMsg({
          kind: "err",
          text: `✗ ${r.error_code ?? "ERR"}: ${r.error_message ?? "未知错误"}`,
        });
      }
    } catch (e: any) {
      setMsg({
        kind: "err",
        text: e.response?.data?.detail ?? e.message,
      });
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="h-full overflow-auto p-3 grid grid-cols-2 gap-3">
      {/* 左：表单 */}
      <div className="bg-bgPanel border border-border rounded p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="text-teal text-sm uppercase tracking-wider">
            大模型 ApiKey（OpenAI 兼容协议）
          </div>
          {view && (
            <span
              className={`text-xs px-2 py-0.5 rounded border ${
                view.configured
                  ? "border-teal text-teal"
                  : "border-amber text-amber"
              }`}
            >
              {view.configured ? "已配置" : "未配置"}
            </span>
          )}
        </div>

        <div className="text-textSub text-xs leading-relaxed">
          只需一个 ApiKey + base_url，鉴权方式为
          <code className="text-amber px-1">Authorization: Bearer ${`{api_key}`}</code>。
          默认指向腾讯混元 OpenAI 兼容端点；前往
          <a
            className="text-teal underline mx-1"
            href="https://console.cloud.tencent.com/hunyuan/start"
            target="_blank"
          >
            混元 ApiKey 控制台
          </a>
          创建。保存后会写入 backend/.env 并重启 SparkSession，
          <code className="text-amber px-1">ai_classify / ai_extract / ai_complete</code>
          下一次执行即走真实 API。
        </div>

        {view && (
          <div className="bg-bgPanel2 border border-border rounded p-2 text-xs">
            <span className="text-textSub">当前 ApiKey：</span>
            <span className="font-mono text-textMain">
              {view.api_key_masked || "(未设置)"}
            </span>
          </div>
        )}

        <Field label="ApiKey">
          <input
            type="password"
            className={input}
            placeholder="sk-xxxxxxxxxxxxxxxx"
            value={form.api_key}
            onChange={(e) => set("api_key", e.target.value.trim())}
          />
        </Field>

        <Field label="Base URL（OpenAI 兼容端点，不要带尾部 /chat/completions）">
          <div className="flex flex-col gap-1.5">
            <input
              className={input}
              placeholder="https://api.hunyuan.cloud.tencent.com/v1"
              value={form.base_url}
              onChange={(e) => set("base_url", e.target.value.trim())}
            />
            <div className="flex gap-1.5 flex-wrap">
              {BASE_PRESETS.map((p) => (
                <button
                  key={p.v}
                  type="button"
                  onClick={() => set("base_url", p.v)}
                  className={`text-xs px-2 py-0.5 rounded border ${
                    form.base_url === p.v
                      ? "border-teal text-teal"
                      : "border-border text-textSub hover:text-teal hover:border-teal"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Small Model（小模型 · 默认 Hy-MT2-Pro）">
            <div className="flex flex-col gap-1.5">
              <input
                className={input}
                value={form.small_model}
                onChange={(e) => set("small_model", e.target.value.trim())}
              />
              <div className="flex gap-1.5 flex-wrap">
                {MODEL_PRESETS.small.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => set("small_model", m.id)}
                    className={`text-xs px-2 py-0.5 rounded border ${
                      form.small_model === m.id
                        ? "border-teal text-teal"
                        : "border-border text-textSub hover:text-teal hover:border-teal"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </Field>
          <Field label="Large Model（大模型 · 默认 Hy3 Preview）">
            <div className="flex flex-col gap-1.5">
              <input
                className={input}
                value={form.large_model}
                onChange={(e) => set("large_model", e.target.value.trim())}
              />
              <div className="flex gap-1.5 flex-wrap">
                {MODEL_PRESETS.large.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => set("large_model", m.id)}
                    className={`text-xs px-2 py-0.5 rounded border ${
                      form.large_model === m.id
                        ? "border-teal text-teal"
                        : "border-border text-textSub hover:text-teal hover:border-teal"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </Field>
          <Field label="Demo Mode 兜底策略">
            <select
              className={input}
              value={form.demo_mode}
              onChange={(e) => set("demo_mode", e.target.value)}
            >
              {DEMO_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex gap-2 mt-2">
          <button
            disabled={busy !== ""}
            onClick={onTest}
            className="px-4 py-1.5 rounded border border-teal text-teal hover:bg-teal hover:text-white text-sm font-semibold disabled:opacity-50"
          >
            {busy === "test" ? "调用中…" : "测试连接"}
          </button>
          <button
            disabled={busy !== ""}
            onClick={onSave}
            className="px-4 py-1.5 rounded bg-teal hover:bg-tealDeep text-white text-sm font-semibold disabled:opacity-50"
          >
            {busy === "save" ? "保存中…" : "保存并重启 Spark"}
          </button>
        </div>

        {msg && (
          <div
            className={`text-xs mt-1 ${
              msg.kind === "ok" ? "text-teal" : "text-amber"
            }`}
          >
            {msg.text}
          </div>
        )}
      </div>

      {/* 右：测试结果 */}
      <div className="bg-bgPanel border border-border rounded p-4 overflow-auto">
        <div className="text-teal text-sm uppercase tracking-wider mb-3">
          大模型 API 实测响应
        </div>

        {!test && (
          <div className="text-textSub text-xs">
            点击左侧「测试连接」会用 <code>{form.small_model}</code> 走一次真实
            <code className="px-1">POST {form.base_url || "<base_url>"}/chat/completions</code>
            ，返回原始 JSON。
          </div>
        )}

        {test && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat
                label="状态"
                value={test.ok ? "✓ 成功" : "✗ 失败"}
                tone={test.ok ? "ok" : "err"}
              />
              <Stat label="耗时" value={`${test.elapsed_ms} ms`} />
              <Stat label="ID / RequestId" value={test.request_id || "-"} />
              <Stat
                label="错误码"
                value={test.error_code || "-"}
                tone={test.error_code ? "err" : undefined}
              />
            </div>

            {test.ok && test.text && (
              <div>
                <div className="text-textSub text-xs mb-1">模型回复</div>
                <pre className="bg-bgPanel2 border border-border rounded p-3 text-textMain text-sm whitespace-pre-wrap">
                  {test.text}
                </pre>
              </div>
            )}

            {!test.ok && test.error_message && (
              <div>
                <div className="text-textSub text-xs mb-1">错误信息</div>
                <pre className="bg-bgPanel2 border border-amber rounded p-3 text-amber text-xs whitespace-pre-wrap">
                  {test.error_message}
                </pre>
                {test.error_code?.startsWith("HTTP_401") && (
                  <Tip text="ApiKey 无效或未授权：请检查 sk- 前缀的 Key 是否完整、是否在控制台已激活。" />
                )}
                {test.error_code?.startsWith("HTTP_403") && (
                  <Tip text="账号未开通该模型：去对应控制台开通后再试。" />
                )}
                {test.error_code === "EXCEPTION" && (
                  <Tip text="网络异常：检查 base_url 是否填写正确、当前网络能否访问该域名。" />
                )}
              </div>
            )}

            {test.raw && (
              <details className="text-xs">
                <summary className="cursor-pointer text-textSub hover:text-teal">
                  原始 JSON（点击展开）
                </summary>
                <pre className="bg-bgPanel2 border border-border rounded p-3 mt-1 text-textMain max-h-64 overflow-auto">
                  {JSON.stringify(test.raw, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const input =
  "w-full bg-bgPanel2 border border-border rounded px-2 py-1.5 text-sm text-textMain font-mono focus:outline-none focus:border-teal";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-textSub text-xs mb-1">{label}</div>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "err";
}) {
  const color =
    tone === "ok" ? "text-teal" : tone === "err" ? "text-amber" : "text-textMain";
  return (
    <div className="bg-bgPanel2 border border-border rounded px-2 py-1.5">
      <div className="text-textSub" style={{ fontSize: 10 }}>
        {label}
      </div>
      <div className={`font-mono ${color}`}>{value}</div>
    </div>
  );
}

function Tip({ text }: { text: string }) {
  return (
    <div className="text-textSub text-xs mt-2 leading-relaxed border-l-2 border-amber pl-2">
      💡 {text}
    </div>
  );
}

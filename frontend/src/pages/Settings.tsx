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
  { v: "false", label: "false（推荐：必须真实 API · 默认）" },
  { v: "auto", label: "auto（失败自动降级 mock）" },
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
  demo_mode: "false",
};

// 剥离非 ASCII 字符（特别针对从错误提示里复制的 ✓ ✗ ⚠ 💡 🔑 等图标），
// 同时去掉首尾空白与中间空白；用在 ApiKey / base_url 输入框 onChange 上，
// 让坏字符根本进不来 state（避免 httpx 把它放进 Authorization header 抛 ascii 编码错）
function sanitizeAscii(s: string): string {
  return (s || "")
    .replace(/[^\x20-\x7E]/g, "") // 只保留可打印 ASCII（0x20-0x7E）
    .replace(/\s+/g, "") // ApiKey / URL 不允许空白
    .trim();
}

// 测试连接的接口选择（只影响 /api/credentials/test，不影响生产路径）
type TestEndpoint = "chat" | "responses";
const ENDPOINT_INFO: Record<TestEndpoint, { label: string; path: string; desc: string }> = {
  chat: {
    label: "Chat Completions",
    path: "/chat/completions",
    desc: "项目实际生产路径（HunyuanClient.scala 走这个）",
  },
  responses: {
    label: "Responses API",
    path: "/v1/responses",
    desc: "OpenAI 新接口，仅用于排查 Key 在 /v1/responses 是否同样可用",
  },
};

export default function Settings() {
  const [view, setView] = useState<CredentialsView | null>(null);
  const [form, setForm] = useState<CredentialsPayload>(initial);
  const [test, setTest] = useState<TestResponse | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testEndpoint, setTestEndpoint] = useState<TestEndpoint>("chat");

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
      const r = await testCredentials({ ...form, endpoint: testEndpoint });
      setTest(r);
      if (r.ok) {
        setMsg({
          kind: "ok",
          text: `✓ ${ENDPOINT_INFO[testEndpoint].label} 调用成功（${r.elapsed_ms} ms）id=${r.request_id ?? "-"}`,
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
            onChange={(e) => set("api_key", sanitizeAscii(e.target.value))}
          />
        </Field>

        <Field label="Base URL（OpenAI 兼容端点，不要带尾部 /chat/completions）">
          <div className="flex flex-col gap-1.5">
            <input
              className={input}
              placeholder="https://api.hunyuan.cloud.tencent.com/v1"
              value={form.base_url}
              onChange={(e) => set("base_url", sanitizeAscii(e.target.value))}
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

        {/* 测试连接的接口选择（只影响测试，不影响生产路径） */}
        <div>
          <div className="text-textSub text-xs mb-1">
            测试接口（只影响「测试连接」按钮，不影响 ai_classify 等函数的生产路径）
          </div>
          <div className="flex gap-1.5">
            {(["chat", "responses"] as TestEndpoint[]).map((ep) => (
              <button
                key={ep}
                type="button"
                onClick={() => setTestEndpoint(ep)}
                className={`flex-1 px-3 py-1.5 rounded border text-xs text-left ${
                  testEndpoint === ep
                    ? "border-teal text-teal bg-teal/5"
                    : "border-border text-textSub hover:text-teal hover:border-teal"
                }`}
              >
                <div className="font-semibold">{ENDPOINT_INFO[ep].label}</div>
                <div className="font-mono text-[10px] opacity-75">{ENDPOINT_INFO[ep].path}</div>
                <div className="text-[10px] opacity-60 mt-0.5">{ENDPOINT_INFO[ep].desc}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2 mt-2">
          <button
            disabled={busy !== ""}
            onClick={onTest}
            className="px-4 py-1.5 rounded border border-teal text-teal hover:bg-teal hover:text-white text-sm font-semibold disabled:opacity-50"
          >
            {busy === "test" ? "调用中…" : `测试连接 · ${ENDPOINT_INFO[testEndpoint].label}`}
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
            <code className="px-1">POST {form.base_url || "<base_url>"}{ENDPOINT_INFO[testEndpoint].path}</code>
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
                <ErrorDiagnosis
                  code={test.error_code}
                  message={test.error_message}
                  baseUrl={form.base_url}
                  apiKey={form.api_key}
                  requestId={test.request_id}
                />
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

// 把腾讯云网关 / OpenAI 兼容协议的常见错误码翻译成可执行的下一步动作
function ErrorDiagnosis({
  code,
  message,
  baseUrl,
  apiKey,
  requestId,
}: {
  code?: string | null;
  message?: string | null;
  baseUrl: string;
  apiKey: string;
  requestId?: string | null;
}) {
  const c = (code || "").toLowerCase();
  const m = (message || "").toLowerCase();

  // 含非 ASCII 字符（前端已做 sanitize，这里兜底诊断）
  const isNonAscii =
    c === "api_key_non_ascii" ||
    c === "base_url_non_ascii" ||
    m.includes("ascii") ||
    m.includes("\\u");

  // 鉴权类（最高频）
  const isAuth =
    c.startsWith("http_401") ||
    c.startsWith("401") ||
    c === "invalid_api_key" ||
    c === "invalid_request_error" ||
    m.includes("invalid api key") ||
    m.includes("authentication") ||
    m.includes("unauthorized");

  // 余额 / 配额
  const isQuota =
    c.startsWith("http_402") ||
    c.startsWith("http_429") ||
    c.startsWith("429") ||
    m.includes("quota") ||
    m.includes("rate limit") ||
    m.includes("欠费") ||
    m.includes("insufficient");

  // 权限 / 未开通
  const isForbidden = c.startsWith("http_403") || c.startsWith("403");

  // 网络异常
  const isNetwork =
    c === "exception" ||
    m.includes("connect") ||
    m.includes("timeout") ||
    m.includes("getaddrinfo") ||
    m.includes("ssl");

  // 模型不存在
  const isModelMissing =
    c === "model_not_found" ||
    m.includes("model not found") ||
    m.includes("model does not exist") ||
    m.includes("does not have access");

  // ApiKey 长度提示（只做软校验，不阻断）
  const keyLen = (apiKey || "").trim().length;
  const keyShape = (apiKey || "").trim();
  const keyLooksOdd =
    keyShape.length > 0 &&
    !keyShape.startsWith("sk-") &&
    !keyShape.startsWith("Bearer ");

  return (
    <div className="mt-2 space-y-1.5">
      {isNonAscii && (
        <>
          <Tip text="ApiKey / base_url 含非 ASCII 字符（如 ✓ ✗ ⚠ 等图标）：通常是从错误提示里复制时把图标一起带进来了。" />
          <ul className="text-xs text-textSub space-y-0.5 list-disc pl-6">
            <li>已自动剥离不可打印字符；请重新粘贴一段纯 sk-xxxx 形式的 Key 再试</li>
            <li>建议从控制台复制时只选中 sk- 开头到末尾的字符串本体</li>
          </ul>
        </>
      )}

      {isAuth && !isNonAscii && (
        <>
          <Tip text="ApiKey 无效（401002 / invalid_api_key）。这是腾讯云网关返回的鉴权错误，常见原因：" />
          <ul className="text-xs text-textSub space-y-0.5 list-disc pl-6">
            <li>
              ApiKey 已被禁用或删除 →{" "}
              <a
                className="text-teal underline"
                href="https://console.cloud.tencent.com/hunyuan/start"
                target="_blank"
                rel="noreferrer"
              >
                混元控制台
              </a>{" "}
              核对 / 重新生成
            </li>
            <li>
              复制时漏字符 / 多空格（当前长度 <code className="text-textMain">{keyLen}</code>，
              腾讯云 TokenHub 标准 Key 通常 51-52 字符）
            </li>
            {keyLooksOdd && (
              <li className="text-amber">⚠ Key 不以 <code>sk-</code> 开头，可能被错误地复制了 Bearer 前缀或多余引号</li>
            )}
            <li>
              ApiKey 与 base_url 不匹配（当前 base_url：
              <code className="text-textMain font-mono">{baseUrl}</code>）
              {!baseUrl.includes("tokenhub") && !baseUrl.includes("hunyuan") && (
                <span className="text-amber"> ← TokenHub 签发的 Key 必须发到 tokenhub.tencentmaas.com</span>
              )}
            </li>
            {requestId && (
              <li>
                提工单时附上 RequestId：{" "}
                <code className="text-textMain font-mono select-all">{requestId}</code>
              </li>
            )}
          </ul>
        </>
      )}

      {isQuota && (
        <Tip text="额度 / 限频问题：检查腾讯云账户余额、QPS 限额，或稍后重试。" />
      )}

      {isForbidden && !isAuth && (
        <Tip text="403 Forbidden：账号未开通该模型，去对应控制台开通后再试。" />
      )}

      {isModelMissing && (
        <Tip
          text={`模型 id 不被网关识别：当前 small="${''}"，请确认 hy-mt2-pro / hy3-preview 等 id 拼写与网关一致。`}
        />
      )}

      {isNetwork && (
        <Tip text="网络异常：检查 base_url 是否填写正确、当前网络能否访问该域名（公司内网可能需走代理）。" />
      )}

      {!isAuth && !isQuota && !isForbidden && !isNetwork && !isModelMissing && !isNonAscii && (
        <Tip text="未识别的错误码，原始 JSON 已展开在下方供排查。" />
      )}
    </div>
  );
}

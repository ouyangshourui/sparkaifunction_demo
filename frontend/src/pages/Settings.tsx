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

const initial: CredentialsPayload = {
  secret_id: "",
  secret_key: "",
  hunyuan_host: "hunyuan.tencentcloudapi.com",
  small_model: "hunyuan-lite",
  large_model: "hunyuan-pro",
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
        // 不回填 secret，避免明文回传；用户重新输入
        hunyuan_host: v.hunyuan_host || f.hunyuan_host,
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
    if (!form.secret_id || !form.secret_key) {
      setMsg({ kind: "err", text: "SecretId / SecretKey 都不能为空" });
      return;
    }
    setMsg(null);
    setBusy("save");
    try {
      const r = await saveCredentials(form);
      setMsg({
        kind: "ok",
        text: `✓ 已保存到 .env，Spark ${r.spark_restarted ? "已重启" : "未重启"}，混元 API 已生效`,
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
    if (!form.secret_id || !form.secret_key) {
      setMsg({ kind: "err", text: "请先填入 SecretId / SecretKey 再测试" });
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
          text: `✓ 真实调用成功（${r.elapsed_ms} ms）RequestId=${r.request_id ?? "-"}`,
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
            腾讯云混元 API 凭证
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
          填入腾讯云访问凭证（前往
          <a
            className="text-teal underline mx-1"
            href="https://console.cloud.tencent.com/cam/capi"
            target="_blank"
          >
            CAM 控制台
          </a>
          创建 / 查看）。保存后会写入 backend/.env 并重启 SparkSession，
          <code className="text-amber px-1">ai_classify / ai_extract / ai_complete</code>
          下一次执行即走真实混元 API。
        </div>

        {view && (
          <div className="bg-bgPanel2 border border-border rounded p-2 text-xs grid grid-cols-2 gap-2">
            <div>
              <span className="text-textSub">当前 SecretId：</span>
              <span className="font-mono text-textMain">
                {view.secret_id_masked || "(未设置)"}
              </span>
            </div>
            <div>
              <span className="text-textSub">SecretKey：</span>
              <span className="font-mono text-textMain">
                {view.secret_key_set ? "********（已设置）" : "(未设置)"}
              </span>
            </div>
          </div>
        )}

        <Field label="SecretId">
          <input
            className={input}
            placeholder="AKIDxxxxxxxxxxxxxxxx"
            value={form.secret_id}
            onChange={(e) => set("secret_id", e.target.value.trim())}
          />
        </Field>
        <Field label="SecretKey">
          <input
            type="password"
            className={input}
            placeholder="保存时才会落盘；测试时直接走签名调用"
            value={form.secret_key}
            onChange={(e) => set("secret_key", e.target.value.trim())}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="API Host">
            <input
              className={input}
              value={form.hunyuan_host}
              onChange={(e) => set("hunyuan_host", e.target.value.trim())}
            />
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
          <Field label="Small Model（小模型）">
            <input
              className={input}
              value={form.small_model}
              onChange={(e) => set("small_model", e.target.value.trim())}
            />
          </Field>
          <Field label="Large Model（大模型）">
            <input
              className={input}
              value={form.large_model}
              onChange={(e) => set("large_model", e.target.value.trim())}
            />
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
          混元 API 实测响应
        </div>

        {!test && (
          <div className="text-textSub text-xs">
            点击左侧「测试连接」会用 <code>hunyuan-lite</code> 走一次真实
            ChatCompletions 调用，返回原始 Response。
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
              <Stat label="RequestId" value={test.request_id || "-"} />
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
                {test.error_code === "AuthFailure.SignatureFailure" && (
                  <Tip text="签名校验失败：请检查 SecretId/SecretKey 是否粘贴完整、首尾是否带空格。" />
                )}
                {test.error_code === "FailedOperation.ServiceNotActivated" && (
                  <Tip text="该腾讯云账号尚未开通混元服务，请到 https://console.cloud.tencent.com/hunyuan 开通后再试。" />
                )}
                {test.error_code?.startsWith("AuthFailure") && (
                  <Tip text="鉴权失败：确认密钥所属账号的 CAM 已授予 hunyuan:* 权限。" />
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

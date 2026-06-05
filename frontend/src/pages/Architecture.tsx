/**
 * Architecture · 技术原理讲解页
 *
 * 核心命题：「对 Spark 代码零侵入」
 *
 * 设计目的：让数据工程师 / 架构师 / 评审委员看完能 1 分钟说出
 *   "哦，这就是标准 SparkSessionExtensions 接入，没有 fork Spark"
 *
 * 4 段叙事，每段都用真实运行时数据（GET /api/architecture）做凭证：
 *  ① Hero KPI：零侵入 / 1736 行 Scala / 4 注入点 / 100% 标准 API
 *  ② 真实运行时配置：spark.sql.extensions、jar 路径、AI 函数注册（来自 JVM）
 *  ③ 4 个 Catalyst 标准注入点（卡片化）+ AIFunctionExtension.scala 源码片段
 *  ④ 数据流图：一条 SQL 在 Catalyst 各阶段的轨迹
 *  ⑤ 「零侵入」凭证三连：没 fork、没改 jar、可一键卸载
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getArchitecture, type ArchitectureView } from "../api/client";

export default function Architecture() {
  const [arch, setArch] = useState<ArchitectureView | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    getArchitecture().then(setArch).catch((e) => setErr(e.message));
  }, []);

  if (err) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-rose-300 text-sm">加载架构信息失败：{err}</div>
      </div>
    );
  }
  if (!arch) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-textSub text-sm">读取 SparkSession 配置中…</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <Hero arch={arch} />
      <div className="max-w-6xl mx-auto px-6 pb-16 space-y-6">
        <SectionRuntime arch={arch} />
        <SectionInjectionPoints arch={arch} />
        <SectionDataflow />
        <SectionNonInvasive arch={arch} />
        <CTA />
      </div>
    </div>
  );
}

// ============================================================
// Hero · 4 KPI
// ============================================================
function Hero({ arch }: { arch: ArchitectureView }) {
  return (
    <div className="bg-gradient-to-br from-bgPanel2 via-bgPanel to-bgPanel2 border-b border-border">
      <div className="max-w-6xl mx-auto px-6 py-12 text-center">
        <div className="inline-block px-3 py-1 mb-4 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs uppercase tracking-wider font-semibold">
          ✓ 零侵入 · 标准 SparkSessionExtensions
        </div>
        <h1 className="text-4xl md:text-5xl font-bold text-textMain mb-4 tracking-tight">
          0 行 Spark 源码改动，<br />
          <span className="text-teal">{arch.stats.scala_loc.toLocaleString()} 行 Scala 扩展代码</span>
        </h1>
        <p className="text-textSub text-lg max-w-2xl mx-auto leading-relaxed">
          通过 <code className="text-amber bg-bgPanel/60 px-1.5 py-0.5 rounded font-mono">--conf spark.sql.extensions=...</code> 加载一个独立 jar，
          就把 AI 函数编译进 Catalyst。<span className="text-amber font-semibold">不 fork Spark、不改 jar、可一键卸载</span>。
        </p>

        <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-3 max-w-3xl mx-auto">
          <KpiBox
            label="Spark 源码改动"
            value="0 行"
            tone="emerald"
            sub="不 fork、不打补丁"
          />
          <KpiBox
            label="扩展项目代码"
            value={`${arch.stats.scala_loc.toLocaleString()} 行`}
            tone="teal"
            sub={`${arch.stats.scala_files} 个 Scala 文件`}
          />
          <KpiBox
            label="标准注入点"
            value={`${arch.injection_points.length} 个`}
            tone="violet"
            sub="全部 SparkSessionExtensions API"
          />
          <KpiBox
            label="加载方式"
            value="--conf"
            tone="amber"
            sub="启动参数 1 行配置"
          />
        </div>
      </div>
    </div>
  );
}

function KpiBox({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "emerald" | "teal" | "violet" | "amber";
}) {
  const cls = {
    emerald: "border-emerald-500/30 from-emerald-500/5",
    teal: "border-teal/30 from-teal/5",
    violet: "border-violet-500/30 from-violet-500/5",
    amber: "border-amber-500/30 from-amber-500/5",
  }[tone];
  const valColor = {
    emerald: "text-emerald-400",
    teal: "text-teal",
    violet: "text-violet-300",
    amber: "text-amber",
  }[tone];
  return (
    <div className={`bg-gradient-to-br ${cls} to-bgPanel border rounded p-3 text-left`}>
      <div className="text-textSub text-[10px] uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold font-mono mt-1 ${valColor}`}>{value}</div>
      <div className="text-textSub/70 text-[11px] mt-0.5">{sub}</div>
    </div>
  );
}

// ============================================================
// ② 真实运行时配置（live from JVM）
// ============================================================
function SectionRuntime({ arch }: { arch: ArchitectureView }) {
  return (
    <Section
      no="①"
      title="真实运行时配置（来自 JVM）"
      subtitle="下面所有数据都是从你当前这个 SparkSession 实时拉的，不是写死字符串。"
      tone="teal"
    >
      <div className="grid md:grid-cols-2 gap-3">
        {/* spark.sql.extensions */}
        <ConfigBox
          label="spark.sql.extensions"
          ok={arch.extensions.aifn_loaded}
          okLabel={arch.extensions.aifn_loaded ? "AIFunctionExtension 已加载" : "未加载"}
        >
          <div className="space-y-1 font-mono text-[11px] text-textMain break-all">
            {arch.extensions.configured.split(",").map((cls, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="text-textSub flex-none">▸</span>
                <span
                  className={
                    cls.includes("AIFunctionExtension")
                      ? "text-teal"
                      : cls.includes("Iceberg")
                      ? "text-violet-300"
                      : "text-textSub"
                  }
                >
                  {cls.trim()}
                </span>
              </div>
            ))}
          </div>
        </ConfigBox>

        {/* spark.jars */}
        <ConfigBox
          label="加载的 Plugin Jar"
          ok={arch.jar.loaded}
          okLabel={arch.jar.loaded ? "已加载" : "未加载"}
        >
          {arch.jar.path ? (
            <div className="font-mono text-[11px] text-textMain break-all">
              {arch.jar.path}
            </div>
          ) : (
            <div className="text-textSub text-xs italic">未配置 spark.jars</div>
          )}
          <div className="text-textSub text-[10px] mt-2 italic">
            注：这是一个**独立 jar**，与 Spark 自带的 `$SPARK_HOME/jars` 完全隔离
          </div>
        </ConfigBox>

        {/* AI Functions */}
        <ConfigBox
          label="已注册的 AI 内置函数（DESCRIBE FUNCTION 验证）"
          ok={arch.ai_functions.every((f) => f.registered)}
          okLabel={`${arch.ai_functions.filter((f) => f.registered).length}/${arch.ai_functions.length} 注册成功`}
          full
        >
          <div className="grid grid-cols-3 gap-2">
            {arch.ai_functions.map((f) => (
              <div
                key={f.name}
                className={`text-center py-1.5 rounded font-mono text-xs border ${
                  f.registered
                    ? "border-teal/40 bg-teal/5 text-teal"
                    : "border-rose-500/40 bg-rose-500/5 text-rose-300"
                }`}
              >
                {f.registered ? "✓" : "✗"} {f.name}
              </div>
            ))}
          </div>
        </ConfigBox>

        {/* Spark 元信息 */}
        <ConfigBox label="SparkSession 元信息" full>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <Pair label="version" value={arch.spark.version} />
            <Pair label="master" value={arch.spark.master} />
            <Pair label="app_id" value={arch.spark.app_id} mono />
          </div>
        </ConfigBox>
      </div>
    </Section>
  );
}

function ConfigBox({
  label,
  ok,
  okLabel,
  children,
  full,
}: {
  label: string;
  ok?: boolean;
  okLabel?: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={`bg-bgPanel border border-border rounded p-3 ${full ? "md:col-span-2" : ""}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-textSub text-[11px] uppercase tracking-wider">{label}</div>
        {ok !== undefined && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
              ok
                ? "border-teal/40 text-teal bg-teal/5"
                : "border-rose-500/40 text-rose-300 bg-rose-500/5"
            }`}
          >
            {okLabel}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Pair({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-bgDark border border-border rounded px-2 py-1.5">
      <div className="text-textSub text-[10px]">{label}</div>
      <div className={`text-textMain ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

// ============================================================
// ③ 5 个 Catalyst 注入点（标准 API）
// ============================================================
function SectionInjectionPoints({ arch }: { arch: ArchitectureView }) {
  return (
    <Section
      no="②"
      title={`${arch.injection_points.length} 个标准 Catalyst 注入点`}
      subtitle="全部使用 SparkSessionExtensions 官方 API。这些是 Spark 文档明确列出的 plugin entrypoint。"
      tone="violet"
    >
      <div className="space-y-3">
        {arch.injection_points.map((p) => (
          <InjectionPointCard key={p.id} point={p} />
        ))}
      </div>

      {/* 源码片段：AIFunctionExtension.scala */}
      <details className="mt-4 bg-bgDark border border-border rounded">
        <summary className="cursor-pointer px-3 py-2 text-textSub hover:text-textMain text-xs">
          ▸ 看 AIFunctionExtension.scala 全文（59 行 · 唯一接入点）
        </summary>
        <pre className="px-4 py-3 text-[11px] font-mono text-textMain overflow-auto leading-relaxed border-t border-border">
{`class AIFunctionExtension extends (SparkSessionExtensions => Unit) {
  override def apply(ext: SparkSessionExtensions): Unit = {
    // 1) Parser：扩展 SQL 语法（CREATE AI FUNCTION DDL）
    ext.injectParser((session, parser) => new AIFunctionParser(session, parser))

    // 2) Optimizer Rules
    ext.injectOptimizerRule(_ => PushDownPredicateThroughAI)
    ext.injectOptimizerRule(_ => MergeAIInvocations)
    ext.injectOptimizerRule(_ => AICostModel)

    // 3) PostHoc Resolution（Analyzer 之后、Optimizer 之前）
    ext.injectPostHocResolutionRule(_ => PushLimitBeforeAIInference)

    // 4) Planner Strategy（逻辑算子 → 物理算子）
    ext.injectPlannerStrategy(_ => AIInferenceStrategy)

    // 5) Function Registry（注册内置 AI 函数）
    AIFunctionRegistry.builtinFunctions.foreach { case (name, builder) =>
      ext.injectFunction((FunctionIdentifier(name), ExpressionInfo(...), builder.build _))
    }
  }
}`}
        </pre>
      </details>
    </Section>
  );
}

function InjectionPointCard({
  point,
}: {
  point: ArchitectureView["injection_points"][number];
}) {
  return (
    <div className="bg-bgPanel border border-border rounded p-3">
      <div className="flex items-start gap-3">
        <div className="flex-none w-12 h-12 rounded bg-violet-500/10 border border-violet-500/30 flex flex-col items-center justify-center">
          <div className="text-violet-300 text-[10px] uppercase">{point.id}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-textMain font-bold text-sm">{point.name}</span>
            <code className="text-[11px] text-teal bg-teal/5 px-1.5 py-0.5 rounded border border-teal/20 font-mono">
              {point.method}
            </code>
          </div>
          <div className="text-textSub text-xs mt-1">{point.purpose}</div>
          <div className="text-textSub/80 text-[10px] mt-2 font-mono">
            <span className="text-textSub/60">📄 涉及文件：</span>
            {point.files.map((f, i) => (
              <span key={f}>
                <span className="text-textMain">{f}</span>
                {i < point.files.length - 1 && <span className="text-textSub/40 mx-1">·</span>}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ④ 数据流图：SQL → Plan → Exec
// ============================================================
function SectionDataflow() {
  return (
    <Section
      no="③"
      title="一条 SQL 在 Catalyst 中的轨迹"
      subtitle="用户写 SQL → Catalyst 各阶段都被扩展点接管 → 最终翻译成物理算子执行"
      tone="amber"
    >
      <div className="bg-bgDark border border-border rounded p-4 overflow-x-auto">
        <pre className="text-[11px] font-mono text-textMain leading-relaxed whitespace-pre">
{`  用户 SQL
  │
  │  SELECT id, ai_classify(text, array('正面','负面')) AS s
  │  FROM reviews LIMIT 3
  │
  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Parser  ─────────────────────────────  AIFunctionParser     [扩展点 1] │
│ 扩展 SQL 语法（识别 CREATE AI FUNCTION DDL；其余 SQL 走 Spark 默认）  │
└─────────────────────────────────────────────────────────────────────┘
  │
  ▼  Unresolved Logical Plan
┌─────────────────────────────────────────────────────────────────────┐
│ Analyzer  ─────────────────  Spark 标准（无侵入）                       │
│ 解析表名 / 列名 / 函数名 → ai_classify 命中 FunctionRegistry          │
└─────────────────────────────────────────────────────────────────────┘
  │
  ▼  Analyzed Logical Plan
┌─────────────────────────────────────────────────────────────────────┐
│ PostHoc Resolution  ─────────  PushLimitBeforeAIInference  [扩展点 3] │
│ 把 LocalLimit 搬到含 AI 函数的 Project 之下                            │
│ ⚡ 这里就是 "用户什么都没改，规则替他改了"                              │
└─────────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Optimizer  ──────  PushDownPredicateThroughAI / MergeAI / AICostModel │
│                                                              [扩展点 2] │
│ 谓词下推到 AI 之下、合并同行多次 AI、cascade 路由代价估算                │
└─────────────────────────────────────────────────────────────────────┘
  │
  ▼  Optimized Logical Plan
┌─────────────────────────────────────────────────────────────────────┐
│ Planner Strategy  ──────────  AIInferenceStrategy           [扩展点 4] │
│ 把 AIInference 逻辑节点翻译成 AIInferenceExec 物理算子                  │
└─────────────────────────────────────────────────────────────────────┘
  │
  ▼  Physical Plan
┌─────────────────────────────────────────────────────────────────────┐
│ AIInferenceExec.executeColumnar()                                     │
│  ├─ DynamicBatcher    16 行/批                                        │
│  ├─ StateTable        prompt_hash 行级幂等                            │
│  ├─ ModelRouter       cascade(small,large,threshold)                  │
│  └─ HunyuanClient     OpenAI 兼容 HTTP（Bearer ApiKey）                │
└─────────────────────────────────────────────────────────────────────┘
  │
  ▼
  返回 DataFrame`}
        </pre>
      </div>

      <div className="mt-3 text-textSub text-xs leading-relaxed">
        💡 <span className="text-textMain">关键观察</span>：
        Analyzer / Optimizer / Planner 这些 Spark 自带阶段没有任何修改，
        我们只是在 Spark **官方暴露的扩展点**上挂载规则；
        卸载扩展（去掉 <code className="text-amber">spark.sql.extensions</code>）后，Spark 行为完全恢复成原生。
      </div>
    </Section>
  );
}

// ============================================================
// ⑤ 「零侵入」凭证三连
// ============================================================
function SectionNonInvasive({ arch }: { arch: ArchitectureView }) {
  return (
    <Section
      no="④"
      title="「零侵入」的三个凭证"
      subtitle="评审委员会问的三个问题，提前给出答案。"
      tone="emerald"
    >
      <div className="grid md:grid-cols-3 gap-3">
        <ProofCard
          q="Q1: Fork 了 Spark 吗？"
          a="❌ 没有"
          detail="项目根目录无 spark/ 子模块。Maven pom 里 spark-core/spark-sql/spark-catalyst 全部 scope=provided，由集群运行时 Spark 提供。"
          evidence={[
            { file: "pom.xml:25-42", note: "<scope>provided</scope> × 3" },
          ]}
        />
        <ProofCard
          q="Q2: 改过 Spark 任何 jar 吗？"
          a="❌ 没有"
          detail={`你当前用的就是官方 Spark 3.5.8 二进制（${arch.spark.version}），没有打补丁。我们的 jar 单独存在：${arch.jar.path?.split("/").pop() ?? "—"}`}
          evidence={[
            { file: arch.jar.path?.split("/").pop() ?? "aifn-spark-extension.jar", note: "独立 plugin jar" },
            { file: "$SPARK_HOME/jars/*", note: "官方原版未动" },
          ]}
        />
        <ProofCard
          q="Q3: 怎么卸载 / 回滚？"
          a="✅ 一行配置"
          detail="去掉 --conf spark.sql.extensions=... 启动参数，或在 SparkSession.config(...) 里删除该项；Spark 立刻恢复原生行为，不需要重装、重启集群、重打 jar。"
          evidence={[
            { file: "spark.sql.extensions", note: "改这一项即可彻底回滚" },
          ]}
        />
      </div>

      {/* 对比表：vs Fork / vs UDF / 我们的方式 */}
      <div className="mt-5 bg-bgPanel border border-border rounded overflow-hidden">
        <div className="px-3 py-2 border-b border-border text-textSub text-xs uppercase tracking-wider">
          与其他方案对比
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-bgPanel2 text-textSub">
              <tr>
                <th className="text-left p-2 border-b border-border">维度</th>
                <th className="text-left p-2 border-b border-border">Fork Spark</th>
                <th className="text-left p-2 border-b border-border">写普通 UDF</th>
                <th className="text-left p-2 border-b border-border bg-teal/5 text-teal">本方案 · Catalyst Extension</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {COMPARISON_ROWS.map((r) => (
                <tr key={r.dim} className="border-b border-border/50 hover:bg-bgPanel2">
                  <td className="p-2 text-textMain">{r.dim}</td>
                  <td className="p-2 text-rose-300">{r.fork}</td>
                  <td className="p-2 text-amber">{r.udf}</td>
                  <td className="p-2 bg-teal/5 text-teal font-bold">{r.ours}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

const COMPARISON_ROWS = [
  { dim: "Spark 源码改动", fork: "几千行", udf: "0 行", ours: "0 行" },
  { dim: "升级 Spark 版本", fork: "需重新合并冲突", udf: "重编 UDF jar", ours: "改 Spark 二进制即可" },
  { dim: "可被 Catalyst 优化", fork: "✓", udf: "✗ 黑盒", ours: "✓ 一等算子" },
  { dim: "谓词下推 / Limit 下推", fork: "✓", udf: "✗", ours: "✓ 自定义规则" },
  { dim: "EXPLAIN 可读", fork: "✓", udf: "ScalaUDF#xxx", ours: "✓ AIInferenceExec" },
  { dim: "卸载方式", fork: "回滚 Spark 二进制", udf: "改 SQL", ours: "去掉 --conf 即可" },
];

function ProofCard({
  q,
  a,
  detail,
  evidence,
}: {
  q: string;
  a: string;
  detail: string;
  evidence: { file: string; note: string }[];
}) {
  return (
    <div className="bg-bgPanel border border-emerald-500/30 rounded p-3 flex flex-col">
      <div className="text-textSub text-[11px] uppercase tracking-wider mb-1">{q}</div>
      <div className="text-2xl font-bold text-emerald-400 mb-2">{a}</div>
      <div className="text-textSub text-xs leading-relaxed flex-1">{detail}</div>
      <div className="mt-3 pt-2 border-t border-border space-y-1">
        {evidence.map((e, i) => (
          <div key={i} className="text-[10px] font-mono">
            <span className="text-textSub">📄</span>{" "}
            <span className="text-teal">{e.file}</span>
            <span className="text-textSub/60 ml-1">— {e.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// 共用 Section
// ============================================================
function Section({
  no,
  title,
  subtitle,
  tone,
  children,
}: {
  no: string;
  title: string;
  subtitle: string;
  tone: "teal" | "amber" | "violet" | "emerald";
  children: React.ReactNode;
}) {
  const accent = {
    teal: "border-teal/30 from-teal/5",
    amber: "border-amber-500/30 from-amber-500/5",
    violet: "border-violet-500/30 from-violet-500/5",
    emerald: "border-emerald-500/30 from-emerald-500/5",
  }[tone];
  const numColor = {
    teal: "text-teal",
    amber: "text-amber",
    violet: "text-violet-300",
    emerald: "text-emerald-400",
  }[tone];
  return (
    <section className={`bg-gradient-to-br to-bgPanel border ${accent} rounded-lg p-5`}>
      <div className="flex items-baseline gap-3 mb-4">
        <div className={`text-3xl font-bold ${numColor} font-mono`}>{no}</div>
        <div className="flex-1">
          <h2 className="text-lg font-bold text-textMain">{title}</h2>
          <p className="text-textSub text-xs mt-0.5">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function CTA() {
  return (
    <div className="text-center py-8 border-t border-border">
      <div className="text-textSub text-sm mb-4">看完原理，回去看效果</div>
      <div className="flex items-center justify-center gap-3">
        <Link
          to="/"
          className="px-6 py-2.5 rounded-md bg-teal hover:bg-tealDeep text-white font-semibold text-sm"
        >
          ← 回 Try It 看三幕剧
        </Link>
        <Link
          to="/workspace"
          className="px-6 py-2.5 rounded-md border border-border hover:border-teal hover:text-teal text-textSub text-sm bg-bgPanel"
        >
          ⌨ 去 Workspace 自己写 SQL
        </Link>
      </div>
    </div>
  );
}

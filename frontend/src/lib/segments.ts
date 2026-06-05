/**
 * SQL 段记录：在前端 localStorage 维护一个会话级别的"段"列表，
 * 每跑完一次 SQL 把执行前/后的 Metrics 快照存下来，Monitor 页据此出对比卡。
 *
 * 不做后端改动，只在前端"差分"：seg.delta = after - before。
 */
import type { MetricsSnapshot } from "../api/client";

const KEY = "aifn:segments";
const MAX = 20;

export interface SqlSegment {
  id: string;
  /** 用户给段起的简短标签，例如 "原写法" / "子查询" */
  label: string;
  /** SQL 文本（截断到 400 字符） */
  sql: string;
  /** 跑完是否成功 */
  ok: boolean;
  /** 错误信息（失败时） */
  err?: string;
  /** 跑了多久（执行 SQL 的耗时） */
  elapsed_ms: number;
  /** 行数 */
  row_count: number;
  /** 段执行的时间戳 */
  ts: number;
  /** 增量统计：仅本段产生的 AI 调用 / token / 路由分布 */
  delta: {
    total_calls: number;
    total_tokens: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_latency_ms: number;
    calls_by_model: Record<string, number>;
    tokens_by_model: Record<string, number>;
    routed_distribution: Record<string, number>;
  };
  /** 用于"对照组"分组：同一组的两个段会出现在 Monitor 顶部对比卡 */
  groupId?: string;
}

export function loadSegments(): SqlSegment[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch {
    return [];
  }
}

export function saveSegments(segs: SqlSegment[]) {
  try {
    const trimmed = segs.slice(-MAX);
    localStorage.setItem(KEY, JSON.stringify(trimmed));
    // 触发同窗口监听器
    window.dispatchEvent(new CustomEvent("aifn:segments-change"));
  } catch {
    /* ignore quota errors */
  }
}

export function appendSegment(seg: SqlSegment) {
  const all = loadSegments();
  all.push(seg);
  saveSegments(all);
}

export function clearSegments() {
  saveSegments([]);
}

/** 算两个 metrics 快照的差，得到本段产生的增量。 */
export function diffSnapshot(
  before: MetricsSnapshot,
  after: MetricsSnapshot,
): SqlSegment["delta"] {
  const dn = (k: keyof MetricsSnapshot) =>
    Math.max(0, ((after[k] as number | undefined) ?? 0) - ((before[k] as number | undefined) ?? 0));

  const dmap = (
    a?: Record<string, number>,
    b?: Record<string, number>,
  ): Record<string, number> => {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    const out: Record<string, number> = {};
    keys.forEach((k) => {
      const v = ((b || {})[k] ?? 0) - ((a || {})[k] ?? 0);
      if (v > 0) out[k] = v;
    });
    return out;
  };

  return {
    total_calls: dn("total_calls"),
    total_tokens: dn("total_tokens"),
    total_prompt_tokens: dn("total_prompt_tokens"),
    total_completion_tokens: dn("total_completion_tokens"),
    total_latency_ms: dn("total_latency_ms"),
    calls_by_model: dmap(before.calls_by_model, after.calls_by_model),
    tokens_by_model: dmap(before.tokens_by_model, after.tokens_by_model),
    routed_distribution: dmap(before.routed_distribution, after.routed_distribution),
  };
}

/** 找出最新的"对照组"（同一 groupId 的最近两段）。 */
export function latestPair(segs: SqlSegment[]): { a: SqlSegment; b: SqlSegment } | null {
  const grouped: Record<string, SqlSegment[]> = {};
  segs.forEach((s) => {
    if (!s.groupId) return;
    (grouped[s.groupId] ||= []).push(s);
  });
  // 取最近的 group（按最大 ts 排序）
  const groups = Object.values(grouped)
    .filter((arr) => arr.length >= 2)
    .sort((x, y) => Math.max(...y.map((s) => s.ts)) - Math.max(...x.map((s) => s.ts)));
  if (groups.length === 0) return null;
  const g = groups[0];
  // 两两里取顺序最早 vs 最晚
  const sorted = [...g].sort((x, y) => x.ts - y.ts);
  return { a: sorted[0], b: sorted[sorted.length - 1] };
}

/** 给 SQL 取一个简短标签（用于段记录展示）。 */
export function deriveLabel(sql: string): string {
  const s = (sql || "").trim().replace(/\s+/g, " ");
  if (!s) return "(空 SQL)";
  // 截前 32 字
  return s.length > 32 ? s.slice(0, 32) + "…" : s;
}

/** 失败/无 metrics 时的占位 delta。 */
export function emptyDelta(): SqlSegment["delta"] {
  return {
    total_calls: 0,
    total_tokens: 0,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_latency_ms: 0,
    calls_by_model: {},
    tokens_by_model: {},
    routed_distribution: {},
  };
}

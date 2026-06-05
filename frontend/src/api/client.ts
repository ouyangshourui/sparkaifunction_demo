import axios from "axios";

export const api = axios.create({
  baseURL: "/api",
  timeout: 120_000,
});

export interface SqlResult {
  rows: Record<string, any>[];
  schema: { name: string; type: string }[];
  elapsed_ms: number;
  row_count: number;
}

export const executeSql = (sql: string, limit = 100) =>
  api.post<SqlResult>("/sql/execute", { sql, limit }).then((r) => r.data);

export interface PlanNode {
  name: string;
  simple: string;
  category: "ai" | "scan" | "filter" | "project" | "limit" | "shuffle" | "other";
  pushedFilters?: string[] | null;
  runtimeFilters?: string[] | null;
  output?: string[] | null;
  table?: string | null;
  condition?: string | null;
  aiExpressions?: string[] | null;
  children: PlanNode[];
}

export interface ExplainResult {
  plan: string;
  tree: PlanNode;
  plan_baseline?: string;
  tree_baseline?: PlanNode | null;
  plan_pushdown?: string;
  tree_pushdown?: PlanNode | null;
  plan_optimized?: string;
  sections?: {
    parsed?: string;
    analyzed?: string;
    optimized?: string;
    physical?: string;
  };
  diff?: {
    baseline_pushed_filters?: string[] | null;
    optimized_pushed_filters?: string[] | null;
    baseline_ai_position?: string;
    optimized_ai_position?: string;
    baseline_lines?: number;
    pushdown_lines?: number;
    optimized_lines?: number;
    limit_pushed_below_ai?: boolean;
  };
}

export const explainSql = (sql: string) =>
  api.post<ExplainResult>("/sql/explain", { sql, limit: 1 }).then((r) => r.data);

export const listFunctions = () =>
  api.get<{ name: string }[]>("/functions").then((r) => r.data);

export const createFunction = (payload: any) =>
  api.post("/functions", payload).then((r) => r.data);

export interface MetricsSnapshot {
  tokens_by_model?: Record<string, number>;
  prompt_tokens_by_model?: Record<string, number>;
  completion_tokens_by_model?: Record<string, number>;
  calls_by_model?: Record<string, number>;
  latency_ms_by_model?: Record<string, number>;
  routed_distribution?: Record<string, number>;
  total_tokens?: number;
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_calls?: number;
  total_latency_ms?: number;
  avg_latency_ms?: number;
  token_budget?: number;
  qps_limit?: number;
  budget_exhausted?: boolean;
}

export const getMetrics = () => api.get<MetricsSnapshot>("/metrics").then((r) => r.data);
export const resetMetrics = () => api.post("/metrics/reset").then((r) => r.data);

export interface StateView {
  cached_count: number;
  audit_pending: number;
  persisted_count: number;
  table: string;
  sample: { hash: string; preview: string }[];
  error?: string;
}

export const replay = () =>
  api.post<{
    ok: boolean;
    before: number;
    flushed: number;
    cleared: number;
    loaded: number;
    message: string;
  }>("/recovery/replay").then((r) => r.data);

export const listState = () =>
  api.get<StateView>("/recovery/state").then((r) => r.data);

export const clearState = () =>
  api.post<{ cleared: number }>("/recovery/clear").then((r) => r.data);

export const flushDelta = () =>
  api.post<{ flushed: number; table: string }>("/recovery/flush-delta").then((r) => r.data);

export const loadDelta = () =>
  api.post<{ loaded: number; table: string }>("/recovery/load-delta").then((r) => r.data);

// —— 凭证管理 ——
export interface CredentialsView {
  api_key_masked: string;
  api_key_set: boolean;
  base_url: string;
  small_model: string;
  large_model: string;
  demo_mode: string;
  configured: boolean;
}

export interface CredentialsPayload {
  api_key: string;
  base_url: string;
  small_model: string;
  large_model: string;
  demo_mode: string;
}

export interface TestResponse {
  ok: boolean;
  request_id?: string | null;
  text?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  elapsed_ms: number;
  raw?: any;
}

export const getCredentials = () =>
  api.get<CredentialsView>("/credentials").then((r) => r.data);

export const saveCredentials = (p: CredentialsPayload) =>
  api.put<{ ok: boolean; saved: boolean; spark_restarted: boolean }>("/credentials", p).then((r) => r.data);

export const testCredentials = (p: CredentialsPayload) =>
  api.post<TestResponse>("/credentials/test", p).then((r) => r.data);

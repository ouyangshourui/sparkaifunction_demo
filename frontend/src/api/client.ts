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

export const explainSql = (sql: string) =>
  api.post<{ plan: string }>("/sql/explain", { sql, limit: 1 }).then((r) => r.data);

export const listFunctions = () =>
  api.get<{ name: string }[]>("/functions").then((r) => r.data);

export const createFunction = (payload: any) =>
  api.post("/functions", payload).then((r) => r.data);

export const getMetrics = () => api.get("/metrics").then((r) => r.data);

export const replay = () => api.post("/recovery/replay").then((r) => r.data);
export const listState = () => api.get("/recovery/state").then((r) => r.data);
export const clearState = () => api.post("/recovery/clear").then((r) => r.data);

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

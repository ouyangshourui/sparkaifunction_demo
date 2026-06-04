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

/**
 * Token 计费表（每 1k token 价格，CNY）
 *
 * 数据来源：
 *  - Hy3 Preview / Hy-MT2-Pro：腾讯 TokenHub 网关参考价
 *  - GPT-4o：OpenAI 官方
 *  - DeepSeek：deepseek 官方
 *
 * 用途：把 Monitor 里的 prompt/completion tokens 折算成「省了多少钱」KPI，
 * 这是 PM/老板视角能直接读懂的指标，比 total_calls=8 强 10 倍。
 *
 * 不准也没关系：这只是 demo 演示用，用户在 Settings 可改（后续）。
 */
export interface ModelPrice {
  /** 网关 ID（小写连字符）*/
  id: string;
  /** UI 友好名 */
  label: string;
  /** prompt tokens 单价（CNY / 1k tokens）*/
  prompt: number;
  /** completion tokens 单价（CNY / 1k tokens）*/
  completion: number;
}

export const PRICING: Record<string, ModelPrice> = {
  "hy3-preview": { id: "hy3-preview", label: "Hy3 Preview", prompt: 0.012, completion: 0.024 },
  "hy-mt2-pro": { id: "hy-mt2-pro", label: "Hy-MT2-Pro", prompt: 0.001, completion: 0.002 },
  "minimax-m3": { id: "minimax-m3", label: "MiniMax M3", prompt: 0.002, completion: 0.004 },
  "gpt-4o": { id: "gpt-4o", label: "GPT-4o", prompt: 0.018, completion: 0.072 },
  "deepseek-chat": { id: "deepseek-chat", label: "DeepSeek Chat", prompt: 0.001, completion: 0.002 },
  // mock fallback：demo_mode=true 时 Governance 会记 model="mock"
  mock: { id: "mock", label: "mock（演示）", prompt: 0, completion: 0 },
};

/** 默认按 hy-mt2-pro 计价（未匹配时兜底）*/
const DEFAULT = PRICING["hy-mt2-pro"];

export function priceOf(modelId: string): ModelPrice {
  if (!modelId) return DEFAULT;
  // 大小写归一
  const key = modelId.toLowerCase();
  return PRICING[key] || DEFAULT;
}

/**
 * 按模型分布计算总花费（CNY）
 * @param promptByModel  prompt_tokens_by_model
 * @param completionByModel completion_tokens_by_model
 */
export function totalCost(
  promptByModel: Record<string, number> = {},
  completionByModel: Record<string, number> = {},
): number {
  const allKeys = new Set([
    ...Object.keys(promptByModel),
    ...Object.keys(completionByModel),
  ]);
  let cost = 0;
  allKeys.forEach((k) => {
    const p = priceOf(k);
    cost += ((promptByModel[k] ?? 0) / 1000) * p.prompt;
    cost += ((completionByModel[k] ?? 0) / 1000) * p.completion;
  });
  return cost;
}

/** 格式化成 ¥X.XXX */
export function fmtCNY(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "¥0";
  if (n < 0.01) return `¥${n.toFixed(4)}`;
  if (n < 1) return `¥${n.toFixed(3)}`;
  return `¥${n.toFixed(2)}`;
}

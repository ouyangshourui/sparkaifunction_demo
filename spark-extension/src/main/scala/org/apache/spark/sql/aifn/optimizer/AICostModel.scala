package org.apache.spark.sql.aifn.optimizer

import org.apache.spark.sql.catalyst.plans.logical.LogicalPlan
import org.apache.spark.sql.catalyst.rules.Rule
import org.apache.spark.sql.aifn.logical.AIInference

/**
 * AICostModel：在逻辑计划属性中注入 AI 调用代价信息，供后续 CBO 决策。
 *
 * 当前仅做「打标签」：
 *   - 估算每次调用 token 数 → 进 Statistics.sizeInBytes 影响 join 顺序
 *   - 标记 AIInference 的 child 必须 partition 化合理（影响 shuffle）
 *
 * 完整 CBO 接入需扩展 LogicalPlan.computeStats，这里先用 hint 形态传递。
 */
object AICostModel extends Rule[LogicalPlan] {

  override def apply(plan: LogicalPlan): LogicalPlan = plan transform {
    case ai: AIInference =>
      // 把估算 token 写进 options，供 AIInferenceExec 调度时使用
      val tokenPerCall = ai.options.getOrElse("est_tokens", "256").toLong
      val newOpts = ai.options + ("ai_cost_token_per_call" -> tokenPerCall.toString)
      ai.copy(options = newOpts)
  }
}

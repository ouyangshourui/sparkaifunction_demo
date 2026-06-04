package org.apache.spark.sql.aifn.logical

import org.apache.spark.sql.catalyst.expressions.{Attribute, Expression, NamedExpression}
import org.apache.spark.sql.catalyst.plans.logical.{LogicalPlan, UnaryNode}
import org.apache.spark.sql.types._

/**
 * AIInference 是 AI Function 调用在逻辑计划中的「一等公民」。
 *
 * 与 UDF 形态不同：UDF 在优化器看来是一团黑盒 ScalaUDF，无法分析其代价、批量、合并。
 * AIInference 暴露：
 *   - functionName : 调用的 AI 函数（ai_complete / ai_classify / ai_extract / 用户 DDL 注册的）
 *   - model        : 模型标识（hunyuan-lite / hunyuan-pro / cascade(...)）
 *   - inputs       : 入参表达式列表（Catalyst 可以做谓词下推 / 列裁剪 / 表达式折叠）
 *   - outputAttr   : 产出列（可下游引用）
 *   - options      : 治理参数（QPS / token_budget / router 配置）
 *   - child        : 上游 LogicalPlan
 *
 * 优化器规则（MergeAIInvocations）会把同行多次 AIInference 合并成一次；
 * 谓词下推（PushDownPredicateThroughAI）把 Filter 推到 AIInference 之下。
 */
case class AIInference(
    functionName: String,
    model: String,
    inputs: Seq[Expression],
    outputAttr: Attribute,
    options: Map[String, String],
    child: LogicalPlan
) extends UnaryNode {

  override def output: Seq[Attribute] = child.output :+ outputAttr

  override protected def withNewChildInternal(newChild: LogicalPlan): AIInference =
    copy(child = newChild)

  /** AI 调用是确定性输出还是随机？由温度参数决定。Demo 默认温度 0 → 确定性 */
  def isDeterministic: Boolean = options.getOrElse("temperature", "0").toDouble == 0.0

  /** 单行调用估算成本（token），用于 AICostModel 决策 */
  def estimatedTokenCost: Long = options.getOrElse("est_tokens", "256").toLong

  override def simpleString(maxFields: Int): String =
    s"AIInference($functionName, model=$model, inputs=${inputs.length}, opts=${options.size})"
}

package org.apache.spark.sql.aifn.strategy

import org.apache.spark.sql.Strategy
import org.apache.spark.sql.catalyst.expressions.Expression
import org.apache.spark.sql.catalyst.plans.logical.LogicalPlan
import org.apache.spark.sql.execution.SparkPlan
import org.apache.spark.sql.aifn.logical.AIInference
import org.apache.spark.sql.aifn.physical.AIInferenceExec

/**
 * AIInferenceStrategy：把 AIInference LogicalPlan 节点翻译成 AIInferenceExec 物理算子。
 *
 * 注入位置：SparkSessionExtensions.injectPlannerStrategy
 * 触发时机：planner 阶段，遍历逻辑计划匹配自定义节点
 */
object AIInferenceStrategy extends Strategy {
  override def apply(plan: LogicalPlan): Seq[SparkPlan] = plan match {
    case AIInference(name, model, inputs, outAttr, opts, child) =>
      AIInferenceExec(name, model, inputs, outAttr, opts, planLater(child)) :: Nil
    case _ => Nil
  }
}

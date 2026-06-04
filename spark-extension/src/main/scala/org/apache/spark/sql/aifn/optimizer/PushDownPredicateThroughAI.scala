package org.apache.spark.sql.aifn.optimizer

import org.apache.spark.sql.catalyst.expressions.{And, Expression}
import org.apache.spark.sql.catalyst.plans.logical.{Filter, LogicalPlan}
import org.apache.spark.sql.catalyst.rules.Rule
import org.apache.spark.sql.aifn.logical.AIInference

/**
 * PushDownPredicateThroughAI：把 Filter 推到 AIInference 之下。
 *
 * 模式：
 *   Filter(cond, AIInference(...)) → AIInference(Filter(safe_cond, child))  + 剩余条件保留
 *
 * 拆分原则：
 *   - 不引用 AIInference 输出列的谓词 → 安全下推
 *   - 引用 AIInference 输出列的谓词 → 留在原位
 *
 * 收益：把【先调模型再过滤】改成【先过滤再调模型】，推理量直接降一个数量级。
 *
 * 这是 Snowflake AI_FILTER / Databricks Photon 内部都在做的事，但闭源；
 * 我们把规则开放，业务方可在 SparkSessionExtensions 之上扩展。
 */
object PushDownPredicateThroughAI extends Rule[LogicalPlan] {

  override def apply(plan: LogicalPlan): LogicalPlan = plan transform {
    case f @ Filter(cond, ai: AIInference) =>
      val aiOutputAttrs = ai.outputAttr.references
      val (canPush, mustStay) = splitConjunctive(cond).partition { c =>
        c.references.intersect(aiOutputAttrs).isEmpty
      }
      if (canPush.isEmpty) {
        f
      } else {
        val pushed = canPush.reduceOption(And).map(c => Filter(c, ai.child)).getOrElse(ai.child)
        val newAI = ai.copy(child = pushed)
        if (mustStay.isEmpty) newAI
        else Filter(mustStay.reduce(And), newAI)
      }
  }

  private def splitConjunctive(cond: Expression): Seq[Expression] = cond match {
    case And(l, r) => splitConjunctive(l) ++ splitConjunctive(r)
    case other => Seq(other)
  }
}

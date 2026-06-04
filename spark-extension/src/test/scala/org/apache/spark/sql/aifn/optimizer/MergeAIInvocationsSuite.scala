package org.apache.spark.sql.aifn.optimizer

import org.apache.spark.sql.aifn.SharedSparkSessionBase
import org.apache.spark.sql.aifn.logical.AIInference
import org.apache.spark.sql.catalyst.expressions.AttributeReference
import org.apache.spark.sql.catalyst.plans.logical.{LocalRelation, LogicalPlan}
import org.apache.spark.sql.types._
import org.scalatest.funsuite.AnyFunSuite

/**
 * 验证 MergeAIInvocations：
 *   1. 同模型相邻 AIInference 合并成一个
 *   2. 不同模型不合并
 *   3. options 中 merge_disabled=true 不合并
 */
class MergeAIInvocationsSuite
    extends AnyFunSuite with SharedSparkSessionBase {

  private val id   = AttributeReference("id", IntegerType)()
  private val text = AttributeReference("text", StringType)()
  private val baseRel: LogicalPlan = LocalRelation(id, text)

  private def ai(name: String, model: String,
                 child: LogicalPlan,
                 opts: Map[String, String] = Map.empty): AIInference = AIInference(
    functionName = name,
    model = model,
    inputs = Seq(text),
    outputAttr = AttributeReference(s"out_$name", StringType)(),
    options = opts,
    child = child
  )

  test("Two same-model AIInference are merged") {
    val plan: LogicalPlan = ai("classify", "hunyuan-pro",
      ai("extract", "hunyuan-pro", baseRel))
    val merged = MergeAIInvocations(plan)
    merged match {
      case m: AIInference =>
        assert(m.functionName == "extract+classify",
          s"merged name unexpected: ${m.functionName}")
        assert(m.options.get("merge_strategy").contains("json_multifield"))
        assert(m.child.eq(baseRel) || m.child == baseRel,
          "merged AI should sit directly on baseRel")
      case other =>
        fail(s"Expected merged AIInference, got: $other")
    }
  }

  test("Different-model AIInference are NOT merged") {
    val plan: LogicalPlan = ai("classify", "hunyuan-pro",
      ai("extract", "hunyuan-lite", baseRel))
    val result = MergeAIInvocations(plan)
    // 顶层仍是 classify，子节点仍是 extract
    result match {
      case AIInference(_, "hunyuan-pro", _, _, _, c: AIInference)
          if c.model == "hunyuan-lite" => succeed
      case other =>
        fail(s"Expected unchanged stack, got: $other")
    }
  }

  test("merge_disabled=true blocks merging") {
    val plan: LogicalPlan = ai("classify", "hunyuan-pro",
      ai("extract", "hunyuan-pro", baseRel),
      opts = Map("merge_disabled" -> "true"))
    val result = MergeAIInvocations(plan)
    result match {
      case AIInference(_, _, _, _, _, _: AIInference) => succeed
      case other => fail(s"Expected stack preserved, got: $other")
    }
  }
}

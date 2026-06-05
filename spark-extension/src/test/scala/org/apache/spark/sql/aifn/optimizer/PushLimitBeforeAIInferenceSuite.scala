package org.apache.spark.sql.aifn.optimizer

import org.apache.spark.sql.aifn.expressions.{AIClassify, AIComplete}
import org.apache.spark.sql.catalyst.expressions.{
  Alias,
  AttributeReference,
  CreateArray,
  Literal,
  Rand
}
import org.apache.spark.sql.catalyst.plans.logical.{
  GlobalLimit,
  LocalLimit,
  LocalRelation,
  LogicalPlan,
  Project
}
import org.apache.spark.sql.types._
import org.scalatest.funsuite.AnyFunSuite

/**
 * 验证 PushLimitBeforeAIInference（纯 Catalyst 规则测试，不启动 SparkSession）：
 *   1. LocalLimit 上 Project 含 AI → LocalLimit 搬到 Project 之下
 *   2. Project 不含 AI → 规则不触发
 *   3. Project 含 non-deterministic（rand）→ 不推
 *   4. GlobalLimit 形态：保留外层 GlobalLimit，并在 Project 之下插入 LocalLimit
 *   5. 幂等：再次跑规则不会重复变形
 */
class PushLimitBeforeAIInferenceSuite extends AnyFunSuite {

  // 模拟一张表 (id INT, text STRING, country STRING)
  private val id      = AttributeReference("id", IntegerType)()
  private val text    = AttributeReference("text", StringType)()
  private val country = AttributeReference("country", StringType)()
  private val baseRel: LogicalPlan = LocalRelation(id, text, country)

  private def aiClassifyExpr =
    AIClassify(text, CreateArray(Seq(Literal(1), Literal(2))))

  private def aiCompleteExpr = AIComplete(text)

  test("LocalLimit over Project(ai_classify) is moved below Project") {
    val plan: LogicalPlan = LocalLimit(
      Literal(10),
      Project(Seq(id, text, Alias(aiClassifyExpr, "tag")()), baseRel)
    )
    val optimized = PushLimitBeforeAIInference(plan)

    // 期望：Project(_, LocalLimit(_, baseRel))（外层 LocalLimit 被搬走）
    optimized match {
      case Project(_, LocalLimit(_, inner)) =>
        assert(inner == baseRel,
          s"inner LocalLimit's child should be the original relation, got: $inner")
      case other =>
        fail(s"Expected Project(LocalLimit(...)) after pushdown, got: $other")
    }
  }

  test("LocalLimit over Project without AI is NOT pushed") {
    val plan: LogicalPlan = LocalLimit(
      Literal(10),
      Project(Seq(id, text), baseRel)
    )
    val optimized = PushLimitBeforeAIInference(plan)

    // 应当与原 plan 完全相同（fastEquals）
    assert(optimized.fastEquals(plan),
      s"Plan without AI expr should not be transformed, got: $optimized")
  }

  test("LocalLimit over Project with non-deterministic + AI is NOT pushed") {
    // 含 rand() —— 推 Limit 会改变随机性输出语义，必须保留
    val rand = Alias(Rand(42L), "r")()
    val plan: LogicalPlan = LocalLimit(
      Literal(10),
      Project(Seq(id, rand, Alias(aiCompleteExpr, "out")()), baseRel)
    )
    val optimized = PushLimitBeforeAIInference(plan)

    assert(optimized.fastEquals(plan),
      s"Project containing Rand() must not allow Limit pushdown, got: $optimized")
  }

  test("GlobalLimit over Project(ai_*) inserts LocalLimit and keeps outer GlobalLimit") {
    val plan: LogicalPlan = GlobalLimit(
      Literal(5),
      Project(Seq(id, text, Alias(aiClassifyExpr, "tag")()), baseRel)
    )
    val optimized = PushLimitBeforeAIInference(plan)

    optimized match {
      case GlobalLimit(_, Project(_, LocalLimit(_, inner))) =>
        assert(inner == baseRel)
      case other =>
        fail(s"Expected GlobalLimit(Project(LocalLimit(...))) but got: $other")
    }
  }

  test("Idempotent: re-applying the rule on already-pushed plan is a no-op") {
    val plan: LogicalPlan = LocalLimit(
      Literal(10),
      Project(Seq(id, text, Alias(aiClassifyExpr, "tag")()), baseRel)
    )
    val once  = PushLimitBeforeAIInference(plan)
    val twice = PushLimitBeforeAIInference(once)
    assert(once.fastEquals(twice),
      s"Rule must be idempotent. once=$once  twice=$twice")
  }
}

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
  Filter,
  GlobalLimit,
  LocalLimit,
  LocalRelation,
  LogicalPlan,
  Project,
  Union
}
import org.apache.spark.sql.types._
import org.scalatest.funsuite.AnyFunSuite

/**
 * 验证 PushLimitBeforeAIInference（纯 Catalyst 规则测试，不启动 SparkSession）：
 *   1. LocalLimit 上 Project 含 AI → LocalLimit 搬到 Project 之下（原有）
 *   2. Project 不含 AI → 规则不触发（原有）
 *   3. Project 含 non-deterministic（rand）→ 不推（原有）
 *   4. GlobalLimit 形态：保留外层 GlobalLimit，并在 Project 之下插入 LocalLimit（原有）
 *   5. 幂等：再次跑规则不会重复变形（原有）
 *   6. LocalLimit 与 Project(ai) 之间有 Filter → 推到 Project 之下（新增）
 *   7. 多层 Filter 嵌套 → 仍然正确推送（新增）
 *   8. LocalLimit 与 Project(ai) 之间有 Union → 不推送（安全保守）（新增）
 */
class PushLimitBeforeAIInferenceSuite extends AnyFunSuite {

  // 模拟一张表 (id INT, text STRING, country STRING)
  private val id      = AttributeReference("id", IntegerType)()
  private val text    = AttributeReference("text", StringType)()
  private val country = AttributeReference("country", StringType)()
  private val sales   = AttributeReference("sales", IntegerType)()
  private val baseRel: LogicalPlan = LocalRelation(id, text, country, sales)

  private def aiClassifyExpr =
    AIClassify(text, CreateArray(Seq(Literal(1), Literal(2))))

  private def aiCompleteExpr = AIComplete(text)

  test("1. LocalLimit over Project(ai_classify) is moved below Project") {
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

  test("2. LocalLimit over Project without AI is NOT pushed") {
    val plan: LogicalPlan = LocalLimit(
      Literal(10),
      Project(Seq(id, text), baseRel)
    )
    val optimized = PushLimitBeforeAIInference(plan)

    // 应当与原 plan 完全相同（fastEquals）
    assert(optimized.fastEquals(plan),
      s"Plan without AI expr should not be transformed, got: $optimized")
  }

  test("3. LocalLimit over Project with non-deterministic + AI is NOT pushed") {
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

  test("4. GlobalLimit over Project(ai_*) inserts LocalLimit and keeps outer GlobalLimit") {
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

  test("5. Idempotent: re-applying the rule on already-pushed plan is a no-op") {
    val plan: LogicalPlan = LocalLimit(
      Literal(10),
      Project(Seq(id, text, Alias(aiClassifyExpr, "tag")()), baseRel)
    )
    val once  = PushLimitBeforeAIInference(plan)
    val twice = PushLimitBeforeAIInference(once)
    assert(once.fastEquals(twice),
      s"Rule must be idempotent. once=$once  twice=$twice")
  }

  test("6. LocalLimit with Filter between Limit and Project(ai) — push below Project") {
    // 复现用户 bug：WHERE country='US' AND sales>1000 LIMIT 10
    // 原始：LocalLimit(10, Filter(cond, Project(ai, baseRel)))
    // 期望：Project(ai, LocalLimit(10, Filter(cond, baseRel)))
    val cond = Literal(true) // 简化：用 true 代替实际 filter condition
    val plan: LogicalPlan = LocalLimit(
      Literal(10),
      Filter(cond, Project(Seq(id, text, Alias(aiClassifyExpr, "tag")()), baseRel))
    )
    val optimized = PushLimitBeforeAIInference(plan)

    optimized match {
      case Project(aiList, LocalLimit(_, Filter(_, inner))) =>
        // aiList 应包含 aiClassifyExpr
        assert(aiList.exists(_.exists(_.isInstanceOf[AIClassify])),
          s"Project should contain aiClassify, got: $aiList")
        assert(inner == baseRel,
          s"Filter's child should be baseRel, got: $inner")
      case other =>
        fail(s"Expected Project(ai, LocalLimit(10, Filter(cond, baseRel))), got: $other")
    }
  }

  test("7. LocalLimit with nested Filters before Project(ai) — still pushes correctly") {
    // LocalLimit(10, Filter(c1, Filter(c2, Project(ai, baseRel))))
    val c1 = Literal(true)
    val c2 = Literal(true)
    val innerPlan: LogicalPlan = Filter(c2,
      Project(Seq(id, text, Alias(aiClassifyExpr, "tag")()), baseRel))
    val plan: LogicalPlan = LocalLimit(
      Literal(10),
      Filter(c1, innerPlan))
    val optimized = PushLimitBeforeAIInference(plan)

    optimized match {
      case Project(aiList, LocalLimit(_, Filter(_, Filter(_, inner)))) =>
        assert(inner == baseRel,
          s"innermost child should be baseRel, got: $inner")
      case other =>
        fail(s"Expected nested Filter structure after push, got: $other")
    }
  }

  test("8. LocalLimit with Union between Limit and Project(ai) — NOT pushed (safe)") {
    // LocalLimit(10, Union(Project(ai, child1), child2)) — 多分支，不推送
    val child1 = Project(Seq(id, text, Alias(aiClassifyExpr, "tag")()), baseRel)
    val child2 = Project(Seq(id, text), baseRel) // 不含 AI
    val union  = Union(Seq(child1, child2))
    val plan: LogicalPlan = LocalLimit(Literal(10), union)

    val optimized = PushLimitBeforeAIInference(plan)

    // 应当不触发推送（Union 是多子节点，保守不推）
    assert(optimized.fastEquals(plan),
      s"Plan with Union between Limit and Project(ai) should NOT be pushed, got: $optimized")
  }
}

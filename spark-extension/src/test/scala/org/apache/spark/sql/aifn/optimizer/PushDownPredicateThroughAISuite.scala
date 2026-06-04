package org.apache.spark.sql.aifn.optimizer

import org.apache.spark.sql.aifn.SharedSparkSessionBase
import org.apache.spark.sql.aifn.logical.AIInference
import org.apache.spark.sql.catalyst.dsl.expressions._
import org.apache.spark.sql.catalyst.dsl.plans._
import org.apache.spark.sql.catalyst.expressions.{And, AttributeReference, EqualTo, Literal}
import org.apache.spark.sql.catalyst.plans.logical.{Filter, LocalRelation, LogicalPlan}
import org.apache.spark.sql.types._
import org.scalatest.funsuite.AnyFunSuite

/**
 * 验证 PushDownPredicateThroughAI：
 *   1. 不引用 AI 输出的谓词应被推到 AIInference 下方
 *   2. 引用 AI 输出列的谓词必须保留在 AIInference 上方
 *   3. AND 复合条件被正确拆分（一半下推 / 一半保留）
 */
class PushDownPredicateThroughAISuite
    extends AnyFunSuite with SharedSparkSessionBase {

  // 模拟一张表：(id INT, country STRING, sales INT)
  private val id      = AttributeReference("id", IntegerType)()
  private val country = AttributeReference("country", StringType)()
  private val sales   = AttributeReference("sales", IntegerType)()
  private val baseRel: LogicalPlan = LocalRelation(id, country, sales)

  // AIInference 输出列：sentiment STRING
  private val sentiment = AttributeReference("sentiment", StringType)()

  private def aiNode(child: LogicalPlan): AIInference = AIInference(
    functionName = "ai_classify",
    model = "hunyuan-pro",
    inputs = Seq(country),
    outputAttr = sentiment,
    options = Map.empty,
    child = child
  )

  test("Predicate not referencing AI output is pushed down") {
    val plan: LogicalPlan = Filter(
      EqualTo(country, Literal("US")),
      aiNode(baseRel)
    )
    val optimized = PushDownPredicateThroughAI(plan)
    optimized match {
      case AIInference(_, _, _, _, _, Filter(c, _)) =>
        assert(c.semanticEquals(EqualTo(country, Literal("US"))))
      case other =>
        fail(s"Expected AIInference(Filter(...)) but got: $other")
    }
  }

  test("Predicate referencing AI output stays above AIInference") {
    val plan: LogicalPlan = Filter(
      EqualTo(sentiment, Literal("positive")),
      aiNode(baseRel)
    )
    val optimized = PushDownPredicateThroughAI(plan)
    optimized match {
      case Filter(c, _: AIInference) =>
        assert(c.semanticEquals(EqualTo(sentiment, Literal("positive"))))
      case other =>
        fail(s"Expected Filter on top of AIInference but got: $other")
    }
  }

  test("AND of pushable + non-pushable predicates split correctly") {
    val plan: LogicalPlan = Filter(
      And(
        EqualTo(country, Literal("US")),       // 可下推
        EqualTo(sentiment, Literal("positive"))// 必须保留
      ),
      aiNode(baseRel)
    )
    val optimized = PushDownPredicateThroughAI(plan)
    optimized match {
      case Filter(stay, ai: AIInference) =>
        assert(stay.semanticEquals(EqualTo(sentiment, Literal("positive"))),
          s"top filter should be on sentiment, got: $stay")
        ai.child match {
          case Filter(pushed, _) =>
            assert(pushed.semanticEquals(EqualTo(country, Literal("US"))),
              s"pushed filter should be on country, got: $pushed")
          case other =>
            fail(s"Expected pushed Filter under AI, got: $other")
        }
      case other =>
        fail(s"Expected Filter(stay, AIInference(Filter(pushed, base))) got: $other")
    }
  }
}

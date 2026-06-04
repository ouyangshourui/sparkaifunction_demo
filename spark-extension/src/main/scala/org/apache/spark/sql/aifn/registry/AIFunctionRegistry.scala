package org.apache.spark.sql.aifn.registry

import org.apache.spark.sql.catalyst.expressions.Expression
import org.apache.spark.sql.aifn.expressions.{AIClassify, AIComplete, AIExtract}

/**
 * 表达式构造器：FunctionRegistry 注入需要 (name, ExpressionInfo, builder)。
 */
trait ExprBuilder {
  def build(args: Seq[Expression]): Expression
}

object AIFunctionRegistry {

  val builtinFunctions: Seq[(String, ExprBuilder)] = Seq(
    "ai_complete" -> new ExprBuilder {
      override def build(args: Seq[Expression]): Expression = args match {
        case Seq(p) => AIComplete(p)
        case Seq(p, _) => AIComplete(p) // 第二参数 model 走 options，先简化
        case _ => throw new IllegalArgumentException(
          s"ai_complete expects 1 or 2 args, got ${args.length}")
      }
    },
    "ai_classify" -> new ExprBuilder {
      override def build(args: Seq[Expression]): Expression = args match {
        case Seq(t, l) => AIClassify(t, l)
        case _ => throw new IllegalArgumentException(
          s"ai_classify expects 2 args (text, ARRAY<STRING>), got ${args.length}")
      }
    },
    "ai_extract" -> new ExprBuilder {
      override def build(args: Seq[Expression]): Expression = args match {
        case Seq(t, s) => AIExtract(t, s)
        case _ => throw new IllegalArgumentException(
          s"ai_extract expects 2 args (text, schema_json), got ${args.length}")
      }
    }
  )
}

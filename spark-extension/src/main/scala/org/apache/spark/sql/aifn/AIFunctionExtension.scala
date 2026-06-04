package org.apache.spark.sql.aifn

import org.apache.spark.sql.SparkSessionExtensions
import org.apache.spark.sql.aifn.optimizer.{AICostModel, MergeAIInvocations, PushDownPredicateThroughAI}
import org.apache.spark.sql.aifn.parser.AIFunctionParser
import org.apache.spark.sql.aifn.registry.AIFunctionRegistry
import org.apache.spark.sql.aifn.strategy.AIInferenceStrategy

/**
 * SparkSessionExtensions 入口。
 *
 * 通过启动参数 `--conf spark.sql.extensions=org.apache.spark.sql.aifn.AIFunctionExtension`
 * 将 AI Function 编译进 Spark Catalyst：
 *   - Parser   : 注入 CREATE AI FUNCTION DDL
 *   - Optimizer: PushDownPredicateThroughAI / MergeAIInvocations / AICostModel
 *   - Strategy : AIInferenceStrategy 把 AIInference 逻辑节点翻译为 AIInferenceExec
 *   - Function : ai_complete / ai_classify / ai_extract 进 FunctionRegistry
 *
 * 这是「修改 Spark 内核」的标准接入点，无需 fork Spark 源码。
 */
class AIFunctionExtension extends (SparkSessionExtensions => Unit) {

  override def apply(ext: SparkSessionExtensions): Unit = {
    // 1) Parser：扩展 SQL 语法
    ext.injectParser((session, parser) => new AIFunctionParser(session, parser))

    // 2) Optimizer Rules
    ext.injectOptimizerRule(_ => PushDownPredicateThroughAI)
    ext.injectOptimizerRule(_ => MergeAIInvocations)
    ext.injectOptimizerRule(_ => AICostModel)

    // 3) Strategy
    ext.injectPlannerStrategy(_ => AIInferenceStrategy)

    // 4) Functions：注册内置 AI 函数表达式
    AIFunctionRegistry.builtinFunctions.foreach { case (name, builder) =>
      ext.injectFunction((
        org.apache.spark.sql.catalyst.FunctionIdentifier(name),
        new org.apache.spark.sql.catalyst.expressions.ExpressionInfo(
          builder.getClass.getCanonicalName, name),
        builder.build _
      ))
    }
  }
}

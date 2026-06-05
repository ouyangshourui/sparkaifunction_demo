package org.apache.spark.sql.aifn.expressions

import org.apache.spark.sql.catalyst.InternalRow
import org.apache.spark.sql.catalyst.expressions.codegen.CodegenFallback
import org.apache.spark.sql.catalyst.expressions.{Expression, UnaryExpression}
import org.apache.spark.sql.aifn.runtime.InferenceClient
import org.apache.spark.sql.types.{DataType, StringType}
import org.apache.spark.unsafe.types.UTF8String

/**
 * AIComplete：默认透传 prompt → LLM → 文本。
 * 仅在 fallback 路径使用（例如优化器未把它转写为 AIInference 节点时）。
 *
 * 正常路径：CatalystOptimizer 会把 SELECT 中的 ai_complete(col) 提取为 AIInference 节点，
 * 由 AIInferenceStrategy 翻译为 AIInferenceExec 物理算子，享受批处理 / 路由 / 状态恢复。
 */
case class AIComplete(prompt: Expression, model: String = AIComplete.defaultModel)
    extends UnaryExpression with CodegenFallback {

  override def child: Expression = prompt
  override def dataType: DataType = StringType
  override def nullable: Boolean = true
  override def prettyName: String = "ai_complete"

  override def nullSafeEval(input: Any): Any = {
    val text = input.asInstanceOf[UTF8String].toString
    val r = InferenceClient.singleton.completeWith(text, model, jsonMode = false, funcName = "ai_complete")
    UTF8String.fromString(r.text)
  }

  override protected def withNewChildInternal(newChild: Expression): AIComplete =
    copy(prompt = newChild)
}

object AIComplete {
  def defaultModel: String =
    Option(System.getenv("AIFN_DEFAULT_SMALL_MODEL"))
      .orElse(Option(System.getenv("HUNYUAN_DEFAULT_SMALL_MODEL")))
      .getOrElse("hy-mt2-pro")
}

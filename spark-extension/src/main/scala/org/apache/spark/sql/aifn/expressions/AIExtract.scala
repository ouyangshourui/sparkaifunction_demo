package org.apache.spark.sql.aifn.expressions

import org.apache.spark.sql.catalyst.expressions.codegen.CodegenFallback
import org.apache.spark.sql.catalyst.expressions.{Expression, BinaryExpression}
import org.apache.spark.sql.aifn.runtime.InferenceClient
import org.apache.spark.sql.types.{DataType, StringType}
import org.apache.spark.unsafe.types.UTF8String

/**
 * AIExtract(text, schema_json) → JSON STRING
 * 强制 response_format = json_object，下游可用 from_json + schema 解析。
 */
case class AIExtract(text: Expression, schema: Expression, model: String = "hunyuan-pro")
    extends BinaryExpression with CodegenFallback {

  override def left: Expression = text
  override def right: Expression = schema
  override def dataType: DataType = StringType
  override def nullable: Boolean = true
  override def prettyName: String = "ai_extract"

  override def nullSafeEval(textVal: Any, schemaVal: Any): Any = {
    val t = textVal.asInstanceOf[UTF8String].toString
    val s = schemaVal.asInstanceOf[UTF8String].toString
    val prompt = s"请从下面文本中按 JSON Schema 抽取信息：\nSchema: ${s}\n文本: ${t}\n只输出 JSON。"
    val out = InferenceClient.singleton.completeBlocking(prompt, model, true)
    UTF8String.fromString(out)
  }

  override protected def withNewChildrenInternal(
      newLeft: Expression, newRight: Expression): AIExtract =
    copy(text = newLeft, schema = newRight)
}

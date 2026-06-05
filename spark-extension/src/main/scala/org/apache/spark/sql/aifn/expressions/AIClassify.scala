package org.apache.spark.sql.aifn.expressions

import org.apache.spark.sql.catalyst.expressions.codegen.CodegenFallback
import org.apache.spark.sql.catalyst.expressions.{Expression, BinaryExpression}
import org.apache.spark.sql.aifn.runtime.InferenceClient
import org.apache.spark.sql.types.{ArrayType, DataType, StringType}
import org.apache.spark.unsafe.types.UTF8String

/**
 * AIClassify(text, ARRAY<STRING>)：把文本归到给定标签集中。
 * 内置 prompt：从给定类别中选最匹配的那个，只输出类别名。
 */
case class AIClassify(text: Expression, labels: Expression, model: String = AIClassify.defaultModel)
    extends BinaryExpression with CodegenFallback {

  override def left: Expression = text
  override def right: Expression = labels
  override def dataType: DataType = StringType
  override def nullable: Boolean = true
  override def prettyName: String = "ai_classify"

  override def checkInputDataTypes(): org.apache.spark.sql.catalyst.analysis.TypeCheckResult = {
    if (left.dataType != StringType) {
      org.apache.spark.sql.catalyst.analysis.TypeCheckResult.TypeCheckFailure(
        "ai_classify: first arg must be STRING")
    } else if (!right.dataType.isInstanceOf[ArrayType]) {
      org.apache.spark.sql.catalyst.analysis.TypeCheckResult.TypeCheckFailure(
        "ai_classify: second arg must be ARRAY<STRING>")
    } else {
      org.apache.spark.sql.catalyst.analysis.TypeCheckResult.TypeCheckSuccess
    }
  }

  override def nullSafeEval(textVal: Any, labelsVal: Any): Any = {
    val t = textVal.asInstanceOf[UTF8String].toString
    val arr = labelsVal.asInstanceOf[org.apache.spark.sql.catalyst.util.ArrayData]
    val labelList = (0 until arr.numElements()).map(i => arr.getUTF8String(i).toString)
    val prompt = s"请从以下类别中选择一个最匹配的：${labelList.mkString("、")}。文本：${t}\n只输出类别名，不要解释。"
    val r = InferenceClient.singleton.completeWith(prompt, model, jsonMode = false, funcName = "ai_classify")
    UTF8String.fromString(r.text.trim)
  }

  override protected def withNewChildrenInternal(
      newLeft: Expression, newRight: Expression): AIClassify =
    copy(text = newLeft, labels = newRight)
}

object AIClassify {
  /** 从环境变量读默认小模型；与后端 settings.DEFAULT_SMALL_MODEL 透传保持一致。 */
  def defaultModel: String =
    Option(System.getenv("AIFN_DEFAULT_SMALL_MODEL"))
      .orElse(Option(System.getenv("HUNYUAN_DEFAULT_SMALL_MODEL")))
      .getOrElse("hy-mt2-pro")
}

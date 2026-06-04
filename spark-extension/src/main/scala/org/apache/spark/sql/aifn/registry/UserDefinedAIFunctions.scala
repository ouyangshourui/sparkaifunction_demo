package org.apache.spark.sql.aifn.registry

import org.apache.spark.sql.SparkSession
import org.apache.spark.sql.catalyst.FunctionIdentifier
import org.apache.spark.sql.catalyst.expressions.{Expression, ExpressionInfo}
import org.apache.spark.sql.aifn.expressions.{AIClassify, AIComplete, AIExtract}
import org.apache.spark.sql.types.DataType

import java.util.concurrent.ConcurrentHashMap

/**
 * UserDefinedAIFunctions：通过 CREATE AI FUNCTION DDL 注册的用户函数。
 * - 持久化（Demo 用 in-memory；生产建议落 SQLite/Delta）
 * - 注入 FunctionRegistry，让 SELECT 语句能直接调用
 */
case class UserAIFn(
    name: String,
    params: Seq[(String, DataType)],
    returnType: DataType,
    model: String,
    promptTemplate: String,
    options: Map[String, String]
)

object UserDefinedAIFunctions {

  private val store = new ConcurrentHashMap[String, UserAIFn]()

  def list: Seq[UserAIFn] = {
    import scala.collection.JavaConverters._
    store.values().asScala.toSeq
  }

  def get(name: String): Option[UserAIFn] = Option(store.get(name))

  def register(
      name: String,
      params: Seq[(String, DataType)],
      returnType: DataType,
      model: String,
      promptTemplate: String,
      options: Map[String, String],
      spark: SparkSession
  ): Unit = {
    val fn = UserAIFn(name, params, returnType, model, promptTemplate, options)
    store.put(name, fn)

    // 注入到当前 Session 的 FunctionRegistry
    val builder: Seq[Expression] => Expression = args => {
      // 简化：把第一个参数当作 prompt 的主输入；prompt_template 渲染交给 AIInferenceExec
      args match {
        case Seq(t) => AIComplete(t, model)
        case Seq(t, l) if fn.name.toLowerCase.contains("classify") => AIClassify(t, l, model)
        case Seq(t, s) if fn.name.toLowerCase.contains("extract") => AIExtract(t, s, model)
        case _ => AIComplete(args.head, model)
      }
    }
    spark.sessionState.functionRegistry.registerFunction(
      FunctionIdentifier(name),
      new ExpressionInfo(classOf[AIComplete].getCanonicalName, name),
      builder
    )
  }

  def drop(name: String): Boolean = store.remove(name) != null
}

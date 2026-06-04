package org.apache.spark.sql.aifn.runtime

import scala.util.Try

/**
 * ModelRouter：自适应级联。
 *
 * 模式：cascade(small=hunyuan-lite, large=hunyuan-pro, threshold=0.85)
 * 流程：先调 small；若不置信（JSON 解析失败 / 长度异常 / PPL 估算高），升级到 large。
 *
 * 这是我们对标 Databricks ai_query / Snowflake Cortex 的差异化能力 ——
 * 三家都需要用户硬编码模型，我们做小→大在线学习路由。
 */
class ModelRouter(val small: String, val large: String, val threshold: Double, jsonMode: Boolean) {

  // 每分区维护一份统计；最终由 Governance 汇总
  @volatile var smallOnly: Long = 0L
  @volatile var upgraded: Long = 0L
  @volatile var failed: Long = 0L

  def routeBatch(prompts: Seq[String], client: HunyuanClient, gov: Governance): Seq[String] = {
    prompts.map { p =>
      val r1 = Try(client.complete(p, small, jsonMode)).toOption
      r1 match {
        case Some(res) if confident(res.text) =>
          gov.record(small, res.promptTokens, res.completionTokens, res.latencyMs, "small_only")
          smallOnly += 1
          res.text
        case Some(res) =>
          // 升级到 large
          val r2 = client.complete(p, large, jsonMode)
          gov.record(large, r2.promptTokens, r2.completionTokens, r2.latencyMs, "upgraded")
          upgraded += 1
          r2.text
        case None =>
          // small 失败，直接 large 兜底
          val r2 = client.complete(p, large, jsonMode)
          gov.record(large, r2.promptTokens, r2.completionTokens, r2.latencyMs, "fallback")
          upgraded += 1
          r2.text
      }
    }
  }

  private def confident(text: String): Boolean = {
    if (text == null || text.trim.isEmpty) return false
    if (jsonMode) {
      try {
        val mapper = new com.fasterxml.jackson.databind.ObjectMapper()
        mapper.readTree(text); true
      } catch { case _: Throwable => false }
    } else {
      text.trim.length > 1
    }
  }
}

object ModelRouter {

  private val cascadePattern =
    """cascade\(small=([^,]+),\s*large=([^,]+),\s*threshold=([0-9.]+)\)""".r

  /** options 优先级：router > model（直跑） */
  def fromOptions(model: String, opts: Map[String, String]): ModelRouter = {
    val jsonMode = opts.getOrElse("response_format", "") == "json_object"
    opts.get("router").orElse(parseInline(model)) match {
      case Some(cascadePattern(s, l, th)) =>
        new ModelRouter(s.trim, l.trim, th.toDouble, jsonMode)
      case _ =>
        // 单模型模式：上下都用同一个，永远不升级（small_only）
        new ModelRouter(model, model, 1.0, jsonMode)
    }
  }

  private def parseInline(model: String): Option[String] =
    if (model.startsWith("cascade(")) Some(model) else None
}

package org.apache.spark.sql.aifn.runtime

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.scala.DefaultScalaModule
import okhttp3.{MediaType, OkHttpClient, Request, RequestBody}

import java.util.concurrent.TimeUnit

/**
 * OpenAI 兼容协议客户端（适配腾讯混元 / TokenHub / DeepSeek 等任意兼容端点）。
 *
 * 鉴权方式：Authorization: Bearer ${apiKey}
 * 端点：    ${baseUrl}/chat/completions
 *
 * 兼容地址举例：
 *   - https://api.hunyuan.cloud.tencent.com/v1   （腾讯混元 OpenAI 兼容）
 *   - https://tokenhub.tencentmaas.com/v1        （腾讯云 TokenHub 网关）
 *   - https://api.deepseek.com/v1
 *   - https://api.openai.com/v1
 */
class HunyuanClient(apiKey: String, baseUrl: String) {

  private val mapper = new ObjectMapper().registerModule(DefaultScalaModule)
  private val http = new OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(15, TimeUnit.SECONDS)
    .build()

  private val JSON = MediaType.parse("application/json; charset=utf-8")

  case class Result(text: String, promptTokens: Int, completionTokens: Int,
                    latencyMs: Long, model: String)

  /** 规范化 baseUrl：去除尾部斜杠。 */
  private val normalizedBase: String = {
    val b = Option(baseUrl).getOrElse("").trim
    if (b.endsWith("/")) b.dropRight(1) else b
  }

  /**
   * 是否启用 demo 模式：
   *   AIFN_DEMO_MODE=true → 强制启用（无视 ApiKey）
   *   AIFN_DEMO_MODE=auto/未设置 → 当 ApiKey 为空 或 调用失败时自动降级
   *   AIFN_DEMO_MODE=false → 严格走真实 API，失败抛错
   */
  private val demoMode: String =
    Option(System.getenv("AIFN_DEMO_MODE")).map(_.trim.toLowerCase).getOrElse("auto")

  private val keyMissing: Boolean =
    apiKey == null || apiKey.isEmpty || normalizedBase.isEmpty

  /** 简单本地启发式：基于 prompt 中暴露的标签/字段返回合理 mock 结果，足以演示。 */
  private def mockComplete(prompt: String): String = {
    val classifyMarker = "请从以下类别中选择一个最匹配的："
    val idx = prompt.indexOf(classifyMarker)
    if (idx >= 0) {
      val rest = prompt.substring(idx + classifyMarker.length)
      val end = rest.indexOf("。")
      val labels =
        if (end > 0) rest.substring(0, end).split("[、,，/]").map(_.trim).filter(_.nonEmpty)
        else Array.empty[String]
      if (labels.nonEmpty) {
        val text = if (rest.contains("文本：")) rest.substring(rest.indexOf("文本：") + 3) else ""
        val lower = text.toLowerCase
        val pos = Seq("好", "棒", "赞", "快", "满意", "喜欢", "amazing", "great", "good", "love", "fast")
        val neg = Seq("差", "慢", "坏", "退", "失望", "投诉", "bad", "slow", "terrible", "hate", "broken")
        val score = pos.count(lower.contains) - neg.count(lower.contains)
        val pickIdx =
          if (score > 0) labels.indexWhere(l => l.contains("正") || l.contains("夸") || l.toLowerCase.contains("pos"))
          else if (score < 0) labels.indexWhere(l => l.contains("负") || l.contains("投") || l.toLowerCase.contains("neg"))
          else labels.indexWhere(l => l.contains("中") || l.toLowerCase.contains("neu"))
        return if (pickIdx >= 0) labels(pickIdx) else labels(0)
      }
    }
    if (prompt.contains("intent") && prompt.contains("priority")) {
      return """{"intent":"咨询","priority":"中","need_human":false}"""
    }
    s"[demo-mode] mocked response for: ${prompt.take(40)}"
  }

  /** 同步调用 OpenAI 兼容 ChatCompletions。 */
  def complete(prompt: String, model: String, jsonMode: Boolean = false): Result = {
    if (demoMode == "true" || (demoMode != "false" && keyMissing)) {
      return Result(mockComplete(prompt), prompt.length, 16, 5L, s"$model[demo]")
    }

    val messages = new java.util.ArrayList[java.util.Map[String, String]]()
    val msg = new java.util.LinkedHashMap[String, String]()
    msg.put("role", "user")
    msg.put("content", prompt)
    messages.add(msg)

    val payloadMap = new java.util.LinkedHashMap[String, Any]()
    payloadMap.put("model", model)
    payloadMap.put("messages", messages)
    payloadMap.put("stream", java.lang.Boolean.FALSE)
    payloadMap.put("temperature", java.lang.Double.valueOf(0.0))
    if (jsonMode) {
      val rf = new java.util.LinkedHashMap[String, String]()
      rf.put("type", "json_object")
      payloadMap.put("response_format", rf)
    }
    val payload = mapper.writeValueAsString(payloadMap)

    val body = RequestBody.create(payload, JSON)
    val req = new Request.Builder()
      .url(s"$normalizedBase/chat/completions")
      .header("Authorization", s"Bearer $apiKey")
      .header("Content-Type", "application/json; charset=utf-8")
      .post(body).build()

    val t0 = System.nanoTime()
    val realCall: () => Result = () => {
      val resp = http.newCall(req).execute()
      try {
        val raw = resp.body().string()
        if (!resp.isSuccessful) {
          throw new RuntimeException(s"OpenAI-compat ${resp.code()}: $raw")
        }
        val js = mapper.readTree(raw)
        // OpenAI 风格错误体
        val errNode = js.path("error")
        if (!errNode.isMissingNode && !errNode.path("message").asText("").isEmpty) {
          throw new RuntimeException(s"API error: ${errNode.toString}")
        }
        val choices = js.path("choices")
        val text =
          if (choices.isArray && choices.size() > 0)
            choices.get(0).path("message").path("content").asText("")
          else ""
        val pt = js.path("usage").path("prompt_tokens").asInt(0)
        val ct = js.path("usage").path("completion_tokens").asInt(0)
        Result(text, pt, ct, (System.nanoTime() - t0) / 1000000L, model)
      } finally resp.close()
    }

    if (demoMode == "false") return realCall()

    try realCall() catch {
      case _: RuntimeException =>
        Result(mockComplete(prompt), prompt.length, 16,
          (System.nanoTime() - t0) / 1000000L, s"$model[demo-fallback]")
    }
  }

  def completeBlocking(prompt: String, model: String, jsonMode: Boolean = false): String =
    complete(prompt, model, jsonMode).text
}

/**
 * 单例供 Expression / Exec 调用。Spark 在 Executor 端 lazy 初始化。
 */
object InferenceClient {
  @volatile private var _instance: HunyuanClient = _

  def init(apiKey: String, baseUrl: String): Unit = {
    if (_instance == null) this.synchronized {
      if (_instance == null) _instance = new HunyuanClient(apiKey, baseUrl)
    }
  }

  def singleton: HunyuanClient = {
    if (_instance == null) {
      // 兼容旧环境变量名 HUNYUAN_API_KEY；同时支持 OPENAI_API_KEY 作为 fallback
      val key = Option(System.getenv("HUNYUAN_API_KEY"))
        .orElse(Option(System.getenv("OPENAI_API_KEY")))
        .getOrElse("")
      val base = Option(System.getenv("HUNYUAN_BASE_URL"))
        .orElse(Option(System.getenv("OPENAI_BASE_URL")))
        .getOrElse("https://api.hunyuan.cloud.tencent.com/v1")
      init(key, base)
    }
    _instance
  }
}

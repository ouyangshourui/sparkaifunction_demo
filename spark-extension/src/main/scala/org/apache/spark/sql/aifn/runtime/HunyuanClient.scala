package org.apache.spark.sql.aifn.runtime

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.scala.DefaultScalaModule
import okhttp3.{MediaType, OkHttpClient, Request, RequestBody}

import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.concurrent.TimeUnit
import java.util.{Date, TimeZone}
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Hunyuan / 腾讯云 hunyuan.tencentcloudapi.com 同步调用客户端。
 * 使用 TC3-HMAC-SHA256 签名（SecretId / SecretKey）。
 */
class HunyuanClient(secretId: String, secretKey: String, host: String) {

  private val mapper = new ObjectMapper().registerModule(DefaultScalaModule)
  private val http = new OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(15, TimeUnit.SECONDS)
    .build()

  private val JSON = MediaType.parse("application/json; charset=utf-8")
  private val service = "hunyuan"
  private val action = "ChatCompletions"
  private val version = "2023-09-01"
  private val algorithm = "TC3-HMAC-SHA256"

  case class Result(text: String, promptTokens: Int, completionTokens: Int,
                    latencyMs: Long, model: String)

  /** TC3-HMAC-SHA256 签名生成 Authorization 头 */
  private def buildAuthorization(timestamp: Long, payload: String): String = {
    val sdf = new SimpleDateFormat("yyyy-MM-dd")
    sdf.setTimeZone(TimeZone.getTimeZone("UTC"))
    val date = sdf.format(new Date(timestamp * 1000L))

    // 1. canonical request
    val httpRequestMethod = "POST"
    val canonicalUri = "/"
    val canonicalQueryString = ""
    val canonicalHeaders =
      "content-type:application/json; charset=utf-8\n" +
      s"host:$host\n" +
      s"x-tc-action:${action.toLowerCase}\n"
    val signedHeaders = "content-type;host;x-tc-action"
    val hashedPayload = sha256Hex(payload)
    val canonicalRequest =
      s"$httpRequestMethod\n$canonicalUri\n$canonicalQueryString\n$canonicalHeaders\n$signedHeaders\n$hashedPayload"

    // 2. string to sign
    val credentialScope = s"$date/$service/tc3_request"
    val hashedCanonicalRequest = sha256Hex(canonicalRequest)
    val stringToSign = s"$algorithm\n$timestamp\n$credentialScope\n$hashedCanonicalRequest"

    // 3. signature
    val secretDate = hmacSha256(("TC3" + secretKey).getBytes("UTF-8"), date)
    val secretService = hmacSha256(secretDate, service)
    val secretSigning = hmacSha256(secretService, "tc3_request")
    val signature = hex(hmacSha256(secretSigning, stringToSign))

    s"$algorithm Credential=$secretId/$credentialScope, SignedHeaders=$signedHeaders, Signature=$signature"
  }

  private def sha256Hex(s: String): String = {
    val md = MessageDigest.getInstance("SHA-256")
    hex(md.digest(s.getBytes("UTF-8")))
  }

  private def hmacSha256(key: Array[Byte], data: String): Array[Byte] = {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(new SecretKeySpec(key, "HmacSHA256"))
    mac.doFinal(data.getBytes("UTF-8"))
  }

  private def hex(bytes: Array[Byte]): String =
    bytes.map(b => "%02x".format(b & 0xff)).mkString

  /**
   * 是否启用 demo 模式：
   *   AIFN_DEMO_MODE=true → 强制启用（无视密钥）
   *   AIFN_DEMO_MODE=auto/未设置 → 当 SecretId/SecretKey 为空 或 调用失败时自动降级
   *   AIFN_DEMO_MODE=false → 严格走真实 API，失败抛错
   */
  private val demoMode: String =
    Option(System.getenv("AIFN_DEMO_MODE")).map(_.trim.toLowerCase).getOrElse("auto")

  private val secretsMissing: Boolean =
    secretId == null || secretId.isEmpty || secretKey == null || secretKey.isEmpty

  /** 简单本地启发式：基于 prompt 中暴露的标签/字段返回合理 mock 结果，足以演示。 */
  private def mockComplete(prompt: String): String = {
    // ai_classify 内置 prompt 形如 "请从以下类别中选择一个最匹配的：A、B、C。文本：xxx"
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
        // 朴素情感判断
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
    // ai_extract / ai_complete 通用兜底
    if (prompt.contains("intent") && prompt.contains("priority")) {
      return """{"intent":"咨询","priority":"中","need_human":false}"""
    }
    s"[demo-mode] mocked response for: ${prompt.take(40)}"
  }

  /** 同步调用混元 ChatCompletions API。 */
  def complete(prompt: String, model: String, jsonMode: Boolean = false): Result = {
    // 1. 强制 demo 模式 / 密钥缺失 → 直接走 mock
    if (demoMode == "true" || (demoMode != "false" && secretsMissing)) {
      return Result(mockComplete(prompt), prompt.length, 16, 5L, s"$model[demo]")
    }

    val messages = new java.util.ArrayList[java.util.Map[String, String]]()
    val msg = new java.util.LinkedHashMap[String, String]()
    msg.put("Role", "user")
    msg.put("Content", prompt)
    messages.add(msg)

    val payloadMap = new java.util.LinkedHashMap[String, Any]()
    payloadMap.put("Model", model)
    payloadMap.put("Messages", messages)
    payloadMap.put("Stream", java.lang.Boolean.FALSE)
    payloadMap.put("Temperature", java.lang.Double.valueOf(0.0))
    val payload = mapper.writeValueAsString(payloadMap)

    val timestamp = System.currentTimeMillis() / 1000L
    val authorization = buildAuthorization(timestamp, payload)

    val body = RequestBody.create(payload, JSON)
    val req = new Request.Builder()
      .url(s"https://$host/")
      .header("Authorization", authorization)
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Host", host)
      .header("X-TC-Action", action)
      .header("X-TC-Timestamp", timestamp.toString)
      .header("X-TC-Version", version)
      .post(body).build()

    val t0 = System.nanoTime()
    val realCall: () => Result = () => {
      val resp = http.newCall(req).execute()
      try {
        val raw = resp.body().string()
        if (!resp.isSuccessful) {
          throw new RuntimeException(s"Hunyuan ${resp.code()}: $raw")
        }
        val js = mapper.readTree(raw)
        val response = js.path("Response")
        val errorNode = response.path("Error")
        if (!errorNode.isMissingNode && !errorNode.path("Code").asText("").isEmpty) {
          throw new RuntimeException(s"Hunyuan API error: ${errorNode.toString}")
        }
        val text = response.path("Choices").get(0).path("Message").path("Content").asText("")
        val pt = response.path("Usage").path("PromptTokens").asInt(0)
        val ct = response.path("Usage").path("CompletionTokens").asInt(0)
        Result(text, pt, ct, (System.nanoTime() - t0) / 1000000L, model)
      } finally resp.close()
    }

    // 2. 严格模式：失败直接抛
    if (demoMode == "false") return realCall()

    // 3. auto 模式：失败降级到 mock
    try realCall() catch {
      case e: RuntimeException =>
        Result(mockComplete(prompt), prompt.length, 16,
          (System.nanoTime() - t0) / 1000000L, s"$model[demo-fallback]")
    }
  }

  /** 直接拿到字符串结果（Expression 路径常用）。 */
  def completeBlocking(prompt: String, model: String, jsonMode: Boolean = false): String =
    complete(prompt, model, jsonMode).text
}

/**
 * 单例供 Expression / Exec 调用。Spark 在 Executor 端 lazy 初始化。
 */
object InferenceClient {
  @volatile private var _instance: HunyuanClient = _

  def init(secretId: String, secretKey: String, host: String): Unit = {
    if (_instance == null) this.synchronized {
      if (_instance == null) _instance = new HunyuanClient(secretId, secretKey, host)
    }
  }

  def singleton: HunyuanClient = {
    if (_instance == null) {
      val sid = Option(System.getenv("TENCENT_SECRET_ID")).getOrElse("")
      val skey = Option(System.getenv("TENCENT_SECRET_KEY")).getOrElse("")
      val host = Option(System.getenv("HUNYUAN_HOST")).getOrElse("hunyuan.tencentcloudapi.com")
      init(sid, skey, host)
    }
    _instance
  }
}

package org.apache.spark.sql.aifn.runtime

import java.util.concurrent.atomic.{AtomicLong, LongAdder}
import java.util.concurrent.ConcurrentHashMap

/**
 * Governance：Token / QPS 配额 + 路由分布统计 + 审计指标。
 *
 * 全局单例（JVM 级）。后端 /metrics API 直接读这里。
 * Token 预算耗尽时抛 BudgetExceeded，可被 driver 端优雅降级到只跑 small 模型。
 */
class Governance(
    qpsLimit: Int,
    tokenBudget: Long
) {
  // 每模型累计
  private val tokenByModel = new ConcurrentHashMap[String, LongAdder]()
  private val promptTokenByModel = new ConcurrentHashMap[String, LongAdder]()
  private val completionTokenByModel = new ConcurrentHashMap[String, LongAdder]()
  private val callsByModel = new ConcurrentHashMap[String, LongAdder]()
  private val latencyByModel = new ConcurrentHashMap[String, LongAdder]()
  private val routedDist = new ConcurrentHashMap[String, LongAdder]() // small_only / upgraded / fallback / failed
  private val totalLatency = new LongAdder()
  private val totalCalls = new LongAdder()

  private val totalTokens = new AtomicLong(0L)
  private val totalPromptTokens = new AtomicLong(0L)
  private val totalCompletionTokens = new AtomicLong(0L)

  def record(model: String, prompt: Int, completion: Int, latency: Long, routed: String): Unit = {
    val total = prompt + completion
    tokenByModel.computeIfAbsent(model, _ => new LongAdder()).add(total.toLong)
    promptTokenByModel.computeIfAbsent(model, _ => new LongAdder()).add(prompt.toLong)
    completionTokenByModel.computeIfAbsent(model, _ => new LongAdder()).add(completion.toLong)
    callsByModel.computeIfAbsent(model, _ => new LongAdder()).increment()
    latencyByModel.computeIfAbsent(model, _ => new LongAdder()).add(latency)
    routedDist.computeIfAbsent(routed, _ => new LongAdder()).increment()
    totalLatency.add(latency)
    totalCalls.increment()
    totalPromptTokens.addAndGet(prompt.toLong)
    totalCompletionTokens.addAndGet(completion.toLong)
    val sum = totalTokens.addAndGet(total.toLong)
    if (sum > tokenBudget) {
      Governance.budgetExhausted = true
    }
  }

  /**
   * 命中行级幂等 cache，只更新 routed_distribution.cache_hit 计数；
   * 不增 total_calls / total_tokens / latency —— 这样 UI 看到的「真实 LLM 调用次数」 = total_calls
   * 与 cache_hit 各自独立，避免混淆。
   */
  def recordCacheHit(): Unit = {
    routedDist.computeIfAbsent("cache_hit", _ => new LongAdder()).increment()
  }

  /** 返回 Java Map（py4j 友好），避免 Scala Map 的桥接问题。 */
  def snapshotJava(): java.util.Map[String, Any] = {
    import scala.collection.JavaConverters._
    val m = new java.util.LinkedHashMap[String, Any]()
    m.put("tokens_by_model", tokenByModel.asScala.map { case (k, v) => (k, v.longValue) }.asJava)
    m.put("prompt_tokens_by_model", promptTokenByModel.asScala.map { case (k, v) => (k, v.longValue) }.asJava)
    m.put("completion_tokens_by_model", completionTokenByModel.asScala.map { case (k, v) => (k, v.longValue) }.asJava)
    m.put("calls_by_model", callsByModel.asScala.map { case (k, v) => (k, v.longValue) }.asJava)
    m.put("latency_ms_by_model", latencyByModel.asScala.map { case (k, v) => (k, v.longValue) }.asJava)
    m.put("routed_distribution", routedDist.asScala.map { case (k, v) => (k, v.longValue) }.asJava)
    m.put("total_tokens", totalTokens.get())
    m.put("total_prompt_tokens", totalPromptTokens.get())
    m.put("total_completion_tokens", totalCompletionTokens.get())
    m.put("total_calls", totalCalls.longValue())
    m.put("total_latency_ms", totalLatency.longValue())
    val tc = totalCalls.longValue()
    val avgLatency = if (tc > 0) totalLatency.longValue().toDouble / tc.toDouble else 0.0
    m.put("avg_latency_ms", avgLatency)
    m.put("token_budget", tokenBudget)
    m.put("qps_limit", qpsLimit)
    m.put("budget_exhausted", Governance.budgetExhausted)
    m
  }

  /** 返回 JSON 字符串。Python 侧直接 json.loads 即可，避开 py4j 嵌套 Map 序列化坑。 */
  def snapshotJson(): String = {
    val mapper = new com.fasterxml.jackson.databind.ObjectMapper()
    mapper.writeValueAsString(snapshotJava())
  }

  /** 兼容旧调用：保留 Scala Map 形式。 */
  def snapshot(): Map[String, Any] = {
    import scala.collection.JavaConverters._
    snapshotJava().asScala.toMap
  }

  /** 重置计数器，便于演示。budget_exhausted 是 object 级共享标记，保持不变。 */
  def reset(): Unit = {
    tokenByModel.clear(); promptTokenByModel.clear(); completionTokenByModel.clear()
    callsByModel.clear(); latencyByModel.clear(); routedDist.clear()
    totalLatency.reset(); totalCalls.reset()
    totalTokens.set(0); totalPromptTokens.set(0); totalCompletionTokens.set(0)
    Governance.budgetExhausted = false
  }
}

object Governance {

  @volatile var budgetExhausted: Boolean = false
  @volatile private var _instance: Governance = _

  def fromOptions(opts: Map[String, String]): Governance = {
    if (_instance == null) this.synchronized {
      if (_instance == null) {
        _instance = new Governance(
          qpsLimit = opts.getOrElse("qps_limit", "50").toInt,
          tokenBudget = opts.getOrElse("token_budget", "1000000").toLong
        )
      }
    }
    _instance
  }

  /**
   * 默认实例：在 Expression 路径（不走 AIInferenceExec）也能得到 Governance。
   * 走环境变量 AIFN_TOKEN_BUDGET / AIFN_QPS_LIMIT；缺省 1_000_000 / 50。
   */
  def default: Governance = {
    if (_instance == null) this.synchronized {
      if (_instance == null) {
        val budget = Option(System.getenv("AIFN_TOKEN_BUDGET")).flatMap(s => scala.util.Try(s.toLong).toOption).getOrElse(1000000L)
        val qps = Option(System.getenv("AIFN_QPS_LIMIT")).flatMap(s => scala.util.Try(s.toInt).toOption).getOrElse(50)
        _instance = new Governance(qpsLimit = qps, tokenBudget = budget)
      }
    }
    _instance
  }

  def instance: Option[Governance] = Option(_instance).orElse(Some(default))
}

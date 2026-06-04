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
  private val callsByModel = new ConcurrentHashMap[String, LongAdder]()
  private val routedDist = new ConcurrentHashMap[String, LongAdder]() // small_only / upgraded / fallback / failed
  private val totalLatency = new LongAdder()

  private val totalTokens = new AtomicLong(0L)

  def record(model: String, prompt: Int, completion: Int, latency: Long, routed: String): Unit = {
    val total = prompt + completion
    tokenByModel.computeIfAbsent(model, _ => new LongAdder()).add(total.toLong)
    callsByModel.computeIfAbsent(model, _ => new LongAdder()).increment()
    routedDist.computeIfAbsent(routed, _ => new LongAdder()).increment()
    totalLatency.add(latency)
    val sum = totalTokens.addAndGet(total.toLong)
    if (sum > tokenBudget) {
      Governance.budgetExhausted = true
    }
  }

  def snapshot(): Map[String, Any] = {
    import scala.collection.JavaConverters._
    Map(
      "tokens_by_model" -> tokenByModel.asScala.map { case (k, v) => (k, v.longValue) }.toMap,
      "calls_by_model" -> callsByModel.asScala.map { case (k, v) => (k, v.longValue) }.toMap,
      "routed_distribution" -> routedDist.asScala.map { case (k, v) => (k, v.longValue) }.toMap,
      "total_tokens" -> totalTokens.get(),
      "token_budget" -> tokenBudget,
      "qps_limit" -> qpsLimit,
      "budget_exhausted" -> Governance.budgetExhausted
    )
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

  def instance: Option[Governance] = Option(_instance)
}

package org.apache.spark.sql.aifn.runtime

import scala.collection.mutable

/**
 * DynamicBatcher：partition 内攒批。
 * 触发 flush 的三个维度：
 *   - 累计条数 >= max_size
 *   - 累计估算 token >= max_tokens
 *   - 等待时长 >= max_wait_ms
 *
 * Demo 在 partition 内同步执行，所以等待时长退化为「最多扫一次完成」。
 * 生产建议：抽到独立 actor / Reactor，跨 partition 共享配额池。
 */
class DynamicBatcher(maxSize: Int, maxTokens: Int, maxWaitMs: Long) {

  /** 同步批处理：把 pending list 切成多个 batch，串行调用 callback 完成所有批。 */
  def runBatch(
      pending: Seq[(Int, String, String)] // idx, prompt, hash
  )(call: Seq[String] => Seq[String]): Seq[(Int, String, String, String)] = {

    val out = mutable.ArrayBuffer.empty[(Int, String, String, String)]
    val buf = mutable.ArrayBuffer.empty[(Int, String, String)]
    var bufTokens = 0

    def flush(): Unit = if (buf.nonEmpty) {
      val results = call(buf.map(_._2))
      buf.zip(results).foreach { case ((idx, prompt, hash), o) =>
        out.append((idx, prompt, hash, o))
      }
      buf.clear(); bufTokens = 0
    }

    pending.foreach { case (idx, prompt, hash) =>
      val est = estimateTokens(prompt)
      if (buf.size >= maxSize || bufTokens + est > maxTokens) flush()
      buf.append((idx, prompt, hash))
      bufTokens += est
    }
    flush()
    out.toSeq
  }

  private def estimateTokens(s: String): Int = math.max(1, s.length / 3)
}

object DynamicBatcher {
  def fromOptions(opts: Map[String, String]): DynamicBatcher = new DynamicBatcher(
    maxSize = opts.getOrElse("batch_max_size", "16").toInt,
    maxTokens = opts.getOrElse("batch_max_tokens", "8000").toInt,
    maxWaitMs = opts.getOrElse("batch_max_wait_ms", "200").toLong
  )
}

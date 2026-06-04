package org.apache.spark.sql.aifn.runtime

import org.apache.spark.sql.SparkSession

import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * StateTable：行级状态 / 幂等表。
 *
 * 设计：
 *   - **Executor 端**：进程级 ConcurrentHashMap 做高性能查 hit；
 *     不直接写 Iceberg（避免每行 IO；分布式写冲突）。
 *   - **Driver 端**：批末由 [[StateTable.flushToDelta]] 把缓存中的新条目以
 *     **MERGE INTO** 形式落到 Iceberg 表 `ai_inference_state`。
 *   - schema：
 *       prompt_hash    STRING (PK)
 *       function_name  STRING
 *       model          STRING
 *       prompt_preview STRING  (前 200 字符，防止表过大)
 *       output         STRING
 *       status         STRING  SUCCESS/FAILED
 *       ts             TIMESTAMP
 *
 * 对比业界：
 *   - Snowflake `TRY_COMPLETE` / BQ `ml_generate_text_status`：仅给状态列
 *   - 我们：行级 hash 表 + 幂等 MERGE，Replay 时直接命中
 */
class StateTable(val tableName: String) {

  // 进程级缓存（multi-partition / multi-task 共享）
  private val cache = StateTable.globalCache

  def computeHash(funcName: String, model: String, prompt: String): String = {
    val md = MessageDigest.getInstance("SHA-256")
    md.update(funcName.getBytes("UTF-8"))
    md.update('|'.toByte)
    md.update(model.getBytes("UTF-8"))
    md.update('|'.toByte)
    md.update(prompt.getBytes("UTF-8"))
    md.digest().map("%02x".format(_)).mkString
  }

  def lookup(hash: String): Option[String] = Option(cache.get(hash))

  def upsert(hash: String, funcName: String, model: String,
             prompt: String, output: String, status: String = "SUCCESS"): Unit = {
    cache.put(hash, output)
    StateTable.appendAuditEntry(
      tableName, hash, funcName, model, prompt, output, status)
  }
}

object StateTable {

  private val globalCache = new ConcurrentHashMap[String, String]()

  case class AuditEntry(
      hash: String,
      fn: String,
      model: String,
      promptPreview: String,
      output: String,
      status: String,
      ts: Long)

  private val auditLog = new java.util.concurrent.ConcurrentLinkedQueue[AuditEntry]()

  def handle(name: String): StateTable = new StateTable(name)

  def appendAuditEntry(table: String, hash: String, fn: String,
                       model: String, prompt: String, output: String,
                       status: String): Unit = {
    val preview = if (prompt == null) "" else
      prompt.substring(0, math.min(prompt.length, 200))
    auditLog.add(AuditEntry(hash, fn, model, preview, output, status,
      System.currentTimeMillis()))
  }

  /** 拉走积累的审计条目（不落盘，纯内存） */
  def drainAudit(): Seq[AuditEntry] = {
    val out = scala.collection.mutable.ArrayBuffer.empty[AuditEntry]
    var e = auditLog.poll()
    while (e != null) { out.append(e); e = auditLog.poll() }
    out.toSeq
  }

  /** 清缓存 → 演示「关闭命中再 Replay」 */
  def clearCache(): Int = {
    val n = globalCache.size()
    globalCache.clear()
    n
  }

  /** 把缓存以可读形式吐出（Recovery 面板用） */
  def listCache(): java.util.Map[String, String] =
    new java.util.HashMap(globalCache)

  /**
   * 把当前积累的 audit 条目以 **MERGE INTO** 形式写入 Iceberg 表（驱动端调用）。
   * - 表不存在自动 CREATE TABLE ... USING iceberg
   * - MERGE 主键：prompt_hash
   * - WHEN MATCHED：更新 output / status / ts（幂等）
   * - WHEN NOT MATCHED：INSERT
   *
   * 调用方：后端 API `/api/recovery/flush` 或定时任务。
   * 该方法运行在 Driver，不会被 Executor 端代码序列化。
   */
  def flushToDelta(spark: SparkSession,
                   tableName: String = "ai_inference_state",
                   warehouseDir: String = "warehouse/ai_state"): Int = {
    val entries = drainAudit()
    if (entries.isEmpty) return 0

    import spark.implicits._
    val df = entries.toDF(
      "prompt_hash", "function_name", "model",
      "prompt_preview", "output", "status", "ts_millis"
    ).withColumn("ts",
      org.apache.spark.sql.functions.to_timestamp(
        (org.apache.spark.sql.functions.col("ts_millis") / 1000).cast("timestamp")))
      .drop("ts_millis")

    val tmpView = s"_aifn_audit_${System.nanoTime()}"
    df.createOrReplaceTempView(tmpView)

    // 1. 表不存在则创建（Iceberg）
    spark.sql(
      s"""
         |CREATE TABLE IF NOT EXISTS $tableName (
         |  prompt_hash    STRING,
         |  function_name  STRING,
         |  model          STRING,
         |  prompt_preview STRING,
         |  output         STRING,
         |  status         STRING,
         |  ts             TIMESTAMP
         |) USING iceberg
         |""".stripMargin)

    // 2. MERGE INTO（幂等，Iceberg 1.6 原生支持 v2 MERGE）
    spark.sql(
      s"""
         |MERGE INTO $tableName AS t
         |USING (SELECT * FROM $tmpView) AS s
         |ON t.prompt_hash = s.prompt_hash
         |WHEN MATCHED THEN UPDATE SET
         |  t.output = s.output,
         |  t.status = s.status,
         |  t.ts     = s.ts
         |WHEN NOT MATCHED THEN INSERT *
         |""".stripMargin)

    spark.catalog.dropTempView(tmpView)
    entries.size
  }

  /**
   * 启动时把 Iceberg 表内容反向加载进进程缓存，
   * 让重启后 Replay 仍能命中历史 hash（演示行级恢复）。
   */
  def loadFromDelta(spark: SparkSession,
                    tableName: String = "ai_inference_state"): Int = {
    val tableExists = spark.catalog.tableExists(tableName)
    if (!tableExists) return 0
    val rows = spark.sql(
      s"SELECT prompt_hash, output FROM $tableName WHERE status = 'SUCCESS'"
    ).collect()
    rows.foreach { r =>
      val h = r.getString(0)
      val o = if (r.isNullAt(1)) "" else r.getString(1)
      globalCache.put(h, o)
    }
    rows.length
  }
}

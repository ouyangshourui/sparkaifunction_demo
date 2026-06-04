package org.apache.spark.sql.aifn

import org.apache.spark.SparkConf
import org.apache.spark.sql.SparkSession
import org.scalatest.{BeforeAndAfterAll, Suite}

/**
 * SharedSparkSessionBase：让所有测试共用一个 SparkSession，避免重复启停。
 *
 * 不直接依赖 Spark 的 SharedSparkSession trait（避免 test-jar 依赖问题），
 * 自实现一份精简版本。
 */
trait SharedSparkSessionBase extends BeforeAndAfterAll { self: Suite =>

  @transient protected var spark: SparkSession = _

  protected def conf: SparkConf = new SparkConf()
    .setMaster("local[2]")
    .setAppName(this.getClass.getSimpleName)
    .set("spark.sql.shuffle.partitions", "2")
    .set("spark.ui.enabled", "false")
    .set("spark.sql.extensions",
      "org.apache.spark.sql.aifn.AIFunctionExtension")

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    spark = SparkSession.builder()
      .config(conf)
      .getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
  }

  override protected def afterAll(): Unit = {
    try {
      if (spark != null) spark.stop()
    } finally {
      super.afterAll()
    }
  }
}

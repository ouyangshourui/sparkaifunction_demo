package org.apache.spark.sql.aifn

import org.scalatest.funsuite.AnyFunSuite

/**
 * 验证 SparkSessionExtensions 注入闭环：
 *   1. extension 加载后 SparkSession 仍可用
 *   2. CREATE AI FUNCTION DDL 能被 ANTLR Parser 识别（不报错）
 *   3. ai_classify / ai_complete / ai_extract 三个内置函数被注册到 FunctionRegistry
 */
class AIFunctionExtensionSuite
    extends AnyFunSuite with SharedSparkSessionBase {

  test("Extension loads and basic SQL still works") {
    val df = spark.range(0, 10)
    assert(df.count() == 10)
  }

  test("Built-in AI functions registered in FunctionRegistry") {
    val reg = spark.sessionState.functionRegistry
    val names = reg.listFunction().map(_.funcName.toLowerCase).toSet
    Seq("ai_complete", "ai_classify", "ai_extract").foreach { fn =>
      assert(names.contains(fn), s"$fn should be registered, got names sample=" +
        names.take(20).mkString(","))
    }
  }

  test("CREATE AI FUNCTION DDL is accepted by ANTLR parser") {
    val ddl =
      """CREATE OR REPLACE AI FUNCTION test_classify(text STRING)
        |RETURNS STRING
        |USING MODEL 'hunyuan-pro'
        |WITH PROMPT '请分类：{text}'
        |OPTIONS (router='cascade(small=hunyuan-lite, large=hunyuan-pro, threshold=0.85)')
        |""".stripMargin
    // 不抛异常即视为通过；side effect = 函数被注册
    spark.sql(ddl).collect()
    val reg = spark.sessionState.functionRegistry
    assert(reg.functionExists(
      org.apache.spark.sql.catalyst.FunctionIdentifier("test_classify")),
      "test_classify should be registered after DDL")
  }
}

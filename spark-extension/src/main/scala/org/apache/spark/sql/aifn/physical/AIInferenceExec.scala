package org.apache.spark.sql.aifn.physical

import org.apache.spark.rdd.RDD
import org.apache.spark.sql.catalyst.InternalRow
import org.apache.spark.sql.catalyst.expressions.{Attribute, Expression, GenericInternalRow, UnsafeProjection}
import org.apache.spark.sql.execution.{SparkPlan, UnaryExecNode}
import org.apache.spark.sql.aifn.runtime.{DynamicBatcher, Governance, InferenceClient, ModelRouter, StateTable}
import org.apache.spark.unsafe.types.UTF8String

import scala.collection.mutable

/**
 * AIInferenceExec：AI Function 的物理算子。
 *
 * 关键能力（与 UDF 形态的本质差异）：
 *   1. 独立 ResourceProfile（与 Shuffle / Scan 解耦，便于 IO-bound 调度）
 *   2. DynamicBatcher：partition 内攒批，按 (size, wait_ms, token) 三维触发 flush
 *   3. ModelRouter：小→大级联，置信度低再升级
 *   4. StateTable：行级幂等，prompt_hash 命中 SUCCESS 直接复用
 *   5. Governance：Token / QPS 配额 + 审计日志
 *
 * 注意：这是「修改 Spark 内核」的体现 —— 普通 UDF 走 Project/Filter 物理算子，
 * 而 AI 调用拥有独立 SparkPlan 节点，物理计划 EXPLAIN 可见。
 */
case class AIInferenceExec(
    functionName: String,
    model: String,
    inputs: Seq[Expression],
    outputAttr: Attribute,
    options: Map[String, String],
    child: SparkPlan
) extends UnaryExecNode {

  override def output: Seq[Attribute] = child.output :+ outputAttr

  override protected def withNewChildInternal(newChild: SparkPlan): AIInferenceExec =
    copy(child = newChild)

  override protected def doExecute(): RDD[InternalRow] = {
    val funcName = functionName
    val mdl = model
    val opts = options
    val outIdx = child.output.length
    val inputProjector = UnsafeProjection.create(inputs, child.output)

    child.execute().mapPartitions { iter =>
      // 每个 partition 独立维护 batcher / router / state（轻量构造）
      val client = InferenceClient.singleton
      val router = ModelRouter.fromOptions(mdl, opts)
      val batcher = DynamicBatcher.fromOptions(opts)
      val state = StateTable.handle(opts.getOrElse("state_table", "ai_function_state"))
      val gov = Governance.fromOptions(opts)

      val cache = mutable.ArrayBuffer.empty[(InternalRow, String)]

      // 阶段 1：收集本 partition 的所有 (row, prompt) 并查 state 命中
      val pending = mutable.ArrayBuffer.empty[(Int, String, String)] // idx, prompt, hash
      val rows = iter.toArray
      rows.zipWithIndex.foreach { case (row, idx) =>
        val projected = inputProjector(row)
        val prompt = renderPrompt(funcName, projected)
        val hash = state.computeHash(funcName, mdl, prompt)
        state.lookup(hash) match {
          case Some(out) =>
            cache.append((row, out))
          case None =>
            pending.append((idx, prompt, hash))
        }
      }

      // 阶段 2：动态批处理 + 路由调用
      val pendingOutputs = batcher.runBatch(pending.toSeq) { prompts =>
        router.routeBatch(prompts, client, gov)
      }

      // 阶段 3：写回 state + 组装输出行
      val ordered = mutable.HashMap.empty[Int, String]
      pendingOutputs.foreach { case (idx, prompt, hash, out) =>
        state.upsert(hash, funcName, mdl, prompt, out)
        ordered.put(idx, out)
      }

      // 阶段 4：按原顺序 emit 行（cache 命中 + pending 完成）
      rows.zipWithIndex.iterator.map { case (row, idx) =>
        val out = ordered.getOrElse(idx, cache.find(_._1 eq row).map(_._2).getOrElse(""))
        val arr = new Array[Any](outIdx + 1)
        var i = 0
        while (i < outIdx) { arr(i) = row.get(i, child.output(i).dataType); i += 1 }
        arr(outIdx) = UTF8String.fromString(out)
        new GenericInternalRow(arr).asInstanceOf[InternalRow]
      }
    }
  }

  /** 简易 prompt 模板渲染。完整版从 AIFunctionRegistry 读取 prompt_template + 占位符替换。 */
  private def renderPrompt(funcName: String, row: InternalRow): String = {
    funcName match {
      case "ai_complete" =>
        row.getUTF8String(0).toString
      case "ai_classify" =>
        val text = row.getUTF8String(0).toString
        val arr = row.getArray(1)
        val labels = (0 until arr.numElements()).map(arr.getUTF8String(_).toString).mkString("、")
        s"请从以下类别中选择一个最匹配的：${labels}。文本：${text}\n只输出类别名，不要解释。"
      case "ai_extract" =>
        val text = row.getUTF8String(0).toString
        val schema = row.getUTF8String(1).toString
        s"请从下面文本中按 JSON Schema 抽取信息：\nSchema: ${schema}\n文本: ${text}\n只输出 JSON。"
      case _ =>
        // DDL 注册的自定义函数：使用 options.prompt_template，并按 inputs 列名占位替换
        val tpl = options.getOrElse("prompt_template", "{0}")
        (0 until row.numFields).foldLeft(tpl) { (acc, i) =>
          acc.replace(s"{$i}", Option(row.getUTF8String(i)).map(_.toString).getOrElse(""))
        }
    }
  }
}

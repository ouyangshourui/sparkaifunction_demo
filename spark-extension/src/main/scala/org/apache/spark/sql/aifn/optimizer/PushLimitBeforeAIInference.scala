package org.apache.spark.sql.aifn.optimizer

import org.apache.spark.internal.Logging
import org.apache.spark.sql.catalyst.expressions.{Expression, NamedExpression}
import org.apache.spark.sql.catalyst.plans.logical.{
  GlobalLimit,
  LocalLimit,
  LogicalPlan,
  Project
}
import org.apache.spark.sql.catalyst.rules.Rule
import org.apache.spark.sql.aifn.expressions.{AIClassify, AIComplete, AIExtract}

/**
 * PushLimitBeforeAIInference：把 Limit N **搬移**到含 AI 函数的 Project 之下。
 *
 * 现象（未应用本规则）：
 * {{{
 *   GlobalLimit 10
 *   +- LocalLimit 10
 *      +- Project [id, text, ai_classify(text, ...) AS tag]   ← AI 在每行都跑
 *         +- Filter (country='US' AND sales>1000)
 *            +- BatchScan reviews
 * }}}
 * 当 Filter 命中 N 行时：ai_classify 调用 N 次 → 然后才取前 10 行返回。
 *
 * 应用本规则后：
 * {{{
 *   GlobalLimit 10
 *   +- Project [id, text, ai_classify(text, ...) AS tag]
 *      +- LocalLimit 10                                        ← 本规则搬移而来
 *         +- Filter (country='US' AND sales>1000)
 *            +- BatchScan reviews
 * }}}
 * 此时：Filter 命中 N 行 → LocalLimit 取 10 → Project 只对 10 行跑 ai_classify
 * → GlobalLimit 10 兜底。AI 调用从 N 次降到 ≤10 次。
 *
 * == 为什么是搬移而不是复制 ==
 *   Project 是 row-preserving（每行 1:1 输出），LocalLimit(N, Project(child))
 *   与 Project(LocalLimit(N, child)) 行数完全相等。
 *   早期版本使用"复制 LocalLimit"会被 Catalyst 后续规则（CombineLimits / 重写）
 *   把内层吃掉，导致最终 plan 看不到下推效果。直接搬移更稳定。
 *
 * == 为什么 Catalyst 不自动做？==
 *   - `LimitPushDown` 默认只穿越 Join/Union/Aggregate(group-only)，不穿越 Project
 *   - `V2ScanRelationPushDown.pushDownLimits` 被 Project 挡住
 *   - 根因：Catalyst 不知道 AI 函数是 row-deterministic（同输入同输出）
 *     盲目推 Limit 到含 non-deterministic UDF 的 Project 下会改变语义
 *
 * == 本规则的安全前提 ==
 *   - Project 中含至少一个 AI 函数（AIClassify / AIComplete / AIExtract）
 *   - 其它表达式 deterministic（含 rand() 之类的就不推）
 *   - AI 函数自身视作 row-deterministic（StateTable prompt_hash 锁定输入↔输出）
 */
object PushLimitBeforeAIInference extends Rule[LogicalPlan] with Logging {

  override def apply(plan: LogicalPlan): LogicalPlan = {
    val out = plan transformDown {

      // 模式 1：LocalLimit 直接位于 Project 之上
      //   LocalLimit(n, Project(ai, child)) → Project(ai, LocalLimit(n, child))
      case LocalLimit(n, Project(projList, child))
          if shouldPush(projList, child) =>
        logWarning(s"[AIFN] push LocalLimit($n) below AI Project")
        Project(projList, LocalLimit(n, child))

      // 模式 2：GlobalLimit 直接位于 Project 之上（少见）
      case GlobalLimit(n, Project(projList, child))
          if shouldPush(projList, child) =>
        logWarning(s"[AIFN] push GlobalLimit($n) (as LocalLimit) below AI Project")
        GlobalLimit(n, Project(projList, LocalLimit(n, child)))
    }
    if (!out.fastEquals(plan)) {
      logWarning(s"[AIFN] PushLimitBeforeAIInference changed plan:\nBEFORE:\n$plan\nAFTER:\n$out")
    }
    out
  }

  /** 是否值得且安全地把 Limit 推到 Project 之下。 */
  private def shouldPush(projList: Seq[NamedExpression], child: LogicalPlan): Boolean = {
    // 防止幂等死循环：Project 的 child 已经是 LocalLimit 就不再下推
    val notAlreadyPushed = !child.isInstanceOf[LocalLimit]
    // 触发条件：Project 中含至少一个 AI 函数
    val hasAI = projList.exists(containsAIExpression)
    // 安全条件：剔除 AI 后所有剩余 Catalyst 节点必须 deterministic
    val safe = projList.forall(isPushSafe)
    notAlreadyPushed && hasAI && safe
  }

  private def containsAIExpression(e: Expression): Boolean = e.exists {
    case _: AIClassify => true
    case _: AIComplete => true
    case _: AIExtract  => true
    case _             => false
  }

  /**
   * Project 表达式整体是否能安全推 Limit：
   *   - AI 函数视作 deterministic（StateTable prompt_hash 锁定输入↔输出）
   *   - 普通 Catalyst 表达式按 deterministic 字段判断
   *   - 含明确 non-deterministic（如 rand()）则不推
   */
  private def isPushSafe(e: Expression): Boolean = {
    val nonAIChildren = e.collect {
      case x if !x.isInstanceOf[AIClassify]
              && !x.isInstanceOf[AIComplete]
              && !x.isInstanceOf[AIExtract] => x
    }
    nonAIChildren.forall(_.deterministic)
  }
}

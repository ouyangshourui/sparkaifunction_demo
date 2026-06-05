package org.apache.spark.sql.aifn.optimizer

import org.apache.spark.internal.Logging
import org.apache.spark.sql.catalyst.expressions.{Expression, NamedExpression}
import org.apache.spark.sql.catalyst.plans.logical.{
  Filter,
  GlobalLimit,
  LocalLimit,
  LogicalPlan,
  Project
}
import org.apache.spark.sql.catalyst.rules.Rule
import org.apache.spark.sql.aifn.expressions.{AIClassify, AIComplete, AIExtract}
import org.apache.spark.sql.internal.SQLConf

/**
 * PushLimitBeforeAIInference：把 Limit N **搬移**到含 AI 函数的 Project 之下。
 *
 * == 运行时开关 ==
 *  通过 SQLConf `spark.aifn.pushLimit.enabled` 控制（默认 true）。
 *  设为 false 时规则直接 return plan，用于 Demo「关闭 vs 开启」对照演示。
 *
 * == 支持的模式 ==
 *  模式 A（原行为）：LocalLimit(n, Project(ai, child))
 *    → Project(ai, LocalLimit(n, child))
 *  模式 B（新增）：LocalLimit(n, Filter(cond, Project(ai, child)))
 *    → Project(ai, LocalLimit(n, Filter(cond, child)))
 *  模式 C（新增·通用）：LocalLimit(n, topNode) 其中 topNode 的子树含 Project(ai)
 *    → Project(ai, LocalLimit(n, topNodeWithoutProject))
 *    前提：Project(ai) 与 Limit 之间必须是线性链（Filter/SubqueryAlias 等单子节点），
 *    不能穿越 Union/Join 等多子节点算子。
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
 *   - Limit 与 Project(ai) 之间只有单子节点算子（Filter/SubqueryAlias 等），
 *     不穿越 Union/Join（多子节点会改变推送语义）
 */
object PushLimitBeforeAIInference extends Rule[LogicalPlan] with Logging {

  /** SQLConf key：运行时开关，false 时规则跳过（用于 demo 对照演示）。 */
  val ENABLED_KEY = "spark.aifn.pushLimit.enabled"

  override def apply(plan: LogicalPlan): LogicalPlan = {
    // 运行时开关：默认 true。读 SQLConf，给 demo 演示「关闭 vs 开启」对照用
    val enabled = SQLConf.get.getConfString(ENABLED_KEY, "true").toBoolean
    if (!enabled) {
      logWarning(s"[AIFN] PushLimitBeforeAIInference disabled by $ENABLED_KEY=false")
      return plan
    }

    val out = plan.transformUp {
      // 模式 1/2/3：LocalLimit(n, ...) 其中 ... 的子树含 Project(ai)
      case l @ LocalLimit(n, topNode) =>
        tryPushLocalLimitBelowAI(l, n, topNode).getOrElse(l)

      // 模式 4/5：GlobalLimit(n, ...) 其中 ... 的子树含 Project(ai)
      case g @ GlobalLimit(n, topNode) =>
        tryPushGlobalLimitBelowAI(g, n, topNode).getOrElse(g)
    }
    if (!out.fastEquals(plan)) {
      logWarning(s"[AIFN] PushLimitBeforeAIInference changed plan:\nBEFORE:\n$plan\nAFTER:\n$out")
    }
    out
  }

  /** 尝试把 LocalLimit(n) 推到 topNode 子树中首个含 AI 的 Project 之下。*/
  private def tryPushLocalLimitBelowAI(
      original: LocalLimit,
      n: Expression,
      topNode: LogicalPlan): Option[LogicalPlan] = {

    // 找 topNode 子树中最顶层的含 AI Project（pre-order 首个匹配）
    val aiProjectOpt = topNode.collectFirst {
      case p: Project if p.projectList.exists(containsAIExpression) => p
    }
    aiProjectOpt.flatMap { aiProject =>
      if (!shouldPush(aiProject.projectList, aiProject.child)) {
        None
      } else if (!isLinearChain(topNode, aiProject)) {
        // Limit 与 Project(ai) 之间有 Union/Join 等多子节点算子，不推送（语义可能变化）
        None
      } else {
        // 在 topNode 中将 aiProject 替换为其 child，得到 topNodeWithoutProject
        val topNodeWithoutProject = replaceNode(topNode, aiProject, aiProject.child)
        Some(aiProject.copy(child = LocalLimit(n, topNodeWithoutProject)))
      }
    }
  }

  /** 尝试把 GlobalLimit(n) 推到 topNode 子树中首个含 AI 的 Project 之下。*/
  private def tryPushGlobalLimitBelowAI(
      original: GlobalLimit,
      n: Expression,
      topNode: LogicalPlan): Option[LogicalPlan] = {

    val aiProjectOpt = topNode.collectFirst {
      case p: Project if p.projectList.exists(containsAIExpression) => p
    }
    aiProjectOpt.flatMap { aiProject =>
      if (!shouldPush(aiProject.projectList, aiProject.child)) {
        None
      } else if (!isLinearChain(topNode, aiProject)) {
        None
      } else {
        val topNodeWithoutProject = replaceNode(topNode, aiProject, aiProject.child)
        Some(GlobalLimit(n, aiProject.copy(child = LocalLimit(n, topNodeWithoutProject))))
      }
    }
  }

  /**
   * 在 tree 中找到 target 节点，用 replacement 替换它。
   * 使用 eq 比较（引用相等），只替换第一个匹配（target 在 tree 中只出现一次）。
   */
  private def replaceNode(tree: LogicalPlan, target: LogicalPlan, replacement: LogicalPlan): LogicalPlan = {
    if (tree.eq(target)) replacement
    else {
      tree.mapChildren { child =>
        replaceNode(child, target, replacement)
      }
    }
  }

  /**
   * 检查 from 到 to 之间是否是「线性链」：
   *   - from 自身或 from 的某个后代是 to
   *   - 从 from 到 to 的路径上所有中间节点都是单子节点（Filter/SubqueryAlias 等）
   *   - 不穿越 Union/Join（多子节点会改变推送语义）
   *
   * 只检查从左子树（children.head）向下走的路径。
   * 如果 to 不在左子树上，保守返回 false（不推送）。
   */
  private def isLinearChain(from: LogicalPlan, to: LogicalPlan): Boolean = {
    var node: LogicalPlan = from
    while (!node.eq(to)) {
      if (node.children.size != 1) return false
      node = node.children.head
    }
    true
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

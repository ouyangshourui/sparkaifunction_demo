package org.apache.spark.sql.aifn.parser

import org.apache.spark.sql.SparkSession
import org.apache.spark.sql.catalyst.expressions.Expression
import org.apache.spark.sql.catalyst.parser.ParserInterface
import org.apache.spark.sql.catalyst.plans.logical.LogicalPlan
import org.apache.spark.sql.catalyst.{FunctionIdentifier, TableIdentifier}
import org.apache.spark.sql.types.{DataType, StructType}
import org.apache.spark.sql.aifn.parser.gen.{AIFunctionDdlLexer, AIFunctionDdlParser, AIFunctionDdlBaseVisitor}
import org.apache.spark.sql.aifn.registry.UserDefinedAIFunctions
import org.antlr.v4.runtime.{BailErrorStrategy, CharStreams, CommonTokenStream}
import org.antlr.v4.runtime.misc.ParseCancellationException

import scala.collection.JavaConverters._

/**
 * AIFunctionParser：在标准 Spark Parser 之上拦截 CREATE AI FUNCTION DDL。
 *
 * 实现：
 *   1. 用 ANTLR4 生成的 Lexer/Parser 尝试匹配 CREATE AI FUNCTION
 *   2. 命中则用 Visitor 提取参数 → UserDefinedAIFunctions.register
 *   3. 不命中则透传给 Spark 默认 ParserInterface
 *
 * 支持语法（EBNF 形式见 AIFunctionDdl.g4）：
 *
 *   CREATE [OR REPLACE] AI FUNCTION <name>(<col_name> <type>, ...)
 *   RETURNS <return_type>
 *   USING MODEL '<model>'
 *   [WITH PROMPT '<template>']
 *   [OPTIONS (key='value', ...)]
 */
class AIFunctionParser(session: SparkSession, delegate: ParserInterface) extends ParserInterface {

  override def parsePlan(sqlText: String): LogicalPlan = {
    tryParseCreateAiFunction(sqlText) match {
      case Some(plan) => plan
      case None       => delegate.parsePlan(sqlText)
    }
  }

  private def tryParseCreateAiFunction(sqlText: String): Option[LogicalPlan] = {
    // 快速判定：必须形似 CREATE [OR REPLACE] AI FUNCTION，避免对所有 SQL 都跑 ANTLR
    val trimmed = sqlText.trim.toUpperCase
    val isAiDdl = trimmed.startsWith("CREATE") &&
      trimmed.contains("AI") &&
      trimmed.contains("FUNCTION")
    if (!isAiDdl) return None

    try {
      val lexer = new AIFunctionDdlLexer(CharStreams.fromString(sqlText))
      lexer.removeErrorListeners()
      val tokens = new CommonTokenStream(lexer)
      val parser = new AIFunctionDdlParser(tokens)
      parser.removeErrorListeners()
      parser.setErrorHandler(new BailErrorStrategy)

      val ctx = parser.singleStatement()
      Some(new AIFunctionDdlBuilder(session).visit(ctx))
    } catch {
      case _: ParseCancellationException => None  // 不是 AI DDL，让 delegate 处理
      case _: NullPointerException       => None
    }
  }

  override def parseExpression(sqlText: String): Expression = delegate.parseExpression(sqlText)
  override def parseTableIdentifier(sqlText: String): TableIdentifier = delegate.parseTableIdentifier(sqlText)
  override def parseFunctionIdentifier(sqlText: String): FunctionIdentifier = delegate.parseFunctionIdentifier(sqlText)
  override def parseMultipartIdentifier(sqlText: String): Seq[String] = delegate.parseMultipartIdentifier(sqlText)
  override def parseTableSchema(sqlText: String): StructType = delegate.parseTableSchema(sqlText)
  override def parseDataType(sqlText: String): DataType = delegate.parseDataType(sqlText)
  override def parseQuery(sqlText: String): LogicalPlan = delegate.parseQuery(sqlText)
}

/**
 * AIFunctionDdlBuilder：把 ANTLR ParseTree 翻译成 LogicalPlan，
 * 同时把函数注册进 UserDefinedAIFunctions 与 SparkSession 的 FunctionRegistry。
 */
class AIFunctionDdlBuilder(session: SparkSession) extends AIFunctionDdlBaseVisitor[LogicalPlan] {

  import AIFunctionDdlParser._

  override def visitSingleStatement(ctx: SingleStatementContext): LogicalPlan =
    visitCreateAiFunction(ctx.createAiFunction())

  override def visitCreateAiFunction(ctx: CreateAiFunctionContext): LogicalPlan = {
    val fnName = textOf(ctx.qualifiedName())
    val params = Option(ctx.paramList()).map(parseParamList).getOrElse(Seq.empty)
    val retType = parseDataType(ctx.dataType())
    val model = unquote(ctx.modelName.getText)
    val prompt = Option(ctx.promptTemplate).map(t => unquote(t.getText)).getOrElse("")
    val options = Option(ctx.optionList()).map(parseOptionList).getOrElse(Map.empty[String, String])

    UserDefinedAIFunctions.register(
      name = fnName,
      params = params,
      returnType = retType,
      model = model,
      promptTemplate = prompt,
      options = options,
      spark = session
    )
    NoopCommand(s"AI function `$fnName` registered (model=$model).")
  }

  // ----- 辅助 -----

  private def textOf(node: org.antlr.v4.runtime.RuleContext): String = node.getText

  private def parseParamList(ctx: ParamListContext): Seq[(String, DataType)] =
    ctx.param().asScala.map { p =>
      val name = textOf(p.identifier())
      val dt = parseDataType(p.dataType())
      (name, dt)
    }.toSeq

  private def parseOptionList(ctx: OptionListContext): Map[String, String] =
    ctx.optionEntry().asScala.map { e =>
      textOf(e.key) -> unquote(e.value.getText)
    }.toMap

  /** 把 ANTLR dataType 子树渲染回字符串，再交给 Spark DataType.fromDDL 解析。 */
  private def parseDataType(ctx: DataTypeContext): DataType = {
    val ddl = renderDataType(ctx)
    DataType.fromDDL(ddl)
  }

  private def renderDataType(ctx: DataTypeContext): String = {
    if (ctx.primitiveType() != null) {
      ctx.primitiveType().getText
    } else if (ctx.structType() != null) {
      val st = ctx.structType()
      val fields = st.structField().asScala.map { f =>
        s"${textOf(f.identifier())}:${renderDataType(f.dataType())}"
      }.mkString(",")
      s"STRUCT<$fields>"
    } else if (ctx.arrayType() != null) {
      s"ARRAY<${renderDataType(ctx.arrayType().dataType())}>"
    } else if (ctx.mapType() != null) {
      val ts = ctx.mapType().dataType().asScala.toSeq
      s"MAP<${renderDataType(ts(0))},${renderDataType(ts(1))}>"
    } else {
      throw new RuntimeException(s"Unsupported data type: ${ctx.getText}")
    }
  }

  private def unquote(s: String): String = {
    if (s == null || s.length < 2) s
    else if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith("\"") && s.endsWith("\""))) {
      s.substring(1, s.length - 1).replace("\\'", "'").replace("\\\"", "\"")
    } else s
  }
}

/** 占位 LogicalPlan：CREATE AI FUNCTION 的执行结果（输出一行确认信息）。 */
case class NoopCommand(message: String) extends org.apache.spark.sql.catalyst.plans.logical.Command {
  override def output: Seq[org.apache.spark.sql.catalyst.expressions.Attribute] = Seq.empty
  override def children: Seq[LogicalPlan] = Seq.empty
  override protected def withNewChildrenInternal(
      newChildren: IndexedSeq[LogicalPlan]): NoopCommand = this
}

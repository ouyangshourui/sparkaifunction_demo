grammar AIFunctionDdl;

/* ============================================================
 *  AI Function DDL grammar - 注入到 Spark Catalyst Parser
 *  作用：识别 CREATE AI FUNCTION 语法，不命中时透传给 Spark 默认 Parser。
 * ============================================================ */

singleStatement
    : createAiFunction SEMICOLON? EOF
    ;

createAiFunction
    : CREATE (OR REPLACE)? AI FUNCTION qualifiedName
      LEFT_PAREN paramList? RIGHT_PAREN
      RETURNS dataType
      USING MODEL modelName=stringLiteral
      (WITH PROMPT promptTemplate=stringLiteral)?
      (OPTIONS LEFT_PAREN optionList? RIGHT_PAREN)?
    ;

paramList
    : param (COMMA param)*
    ;

param
    : identifier dataType
    ;

optionList
    : optionEntry (COMMA optionEntry)*
    ;

optionEntry
    : key=identifier EQ value=stringLiteral
    ;

dataType
    : primitiveType
    | structType
    | arrayType
    | mapType
    ;

primitiveType
    : identifier (LEFT_PAREN INTEGER_VALUE (COMMA INTEGER_VALUE)? RIGHT_PAREN)?
    ;

structType
    : STRUCT LT structField (COMMA structField)* GT
    ;

structField
    : identifier COLON dataType
    ;

arrayType
    : ARRAY LT dataType GT
    ;

mapType
    : MAP LT dataType COMMA dataType GT
    ;

qualifiedName
    : identifier (DOT identifier)*
    ;

identifier
    : IDENTIFIER
    | quotedIdentifier
    | nonReservedKeyword
    ;

quotedIdentifier
    : BACKQUOTED_IDENTIFIER
    ;

nonReservedKeyword
    : MODEL | OPTIONS | PROMPT | RETURNS | USING | WITH
    ;

stringLiteral
    : STRING
    ;

// ===== Tokens =====
AI         : [Aa][Ii] ;
ARRAY      : [Aa][Rr][Rr][Aa][Yy] ;
COLON      : ':' ;
COMMA      : ',' ;
CREATE     : [Cc][Rr][Ee][Aa][Tt][Ee] ;
DOT        : '.' ;
EQ         : '=' ;
FUNCTION   : [Ff][Uu][Nn][Cc][Tt][Ii][Oo][Nn] ;
GT         : '>' ;
LEFT_PAREN : '(' ;
LT         : '<' ;
MAP        : [Mm][Aa][Pp] ;
MODEL      : [Mm][Oo][Dd][Ee][Ll] ;
OPTIONS    : [Oo][Pp][Tt][Ii][Oo][Nn][Ss] ;
OR         : [Oo][Rr] ;
PROMPT     : [Pp][Rr][Oo][Mm][Pp][Tt] ;
REPLACE    : [Rr][Ee][Pp][Ll][Aa][Cc][Ee] ;
RETURNS    : [Rr][Ee][Tt][Uu][Rr][Nn][Ss] ;
RIGHT_PAREN: ')' ;
SEMICOLON  : ';' ;
STRUCT     : [Ss][Tt][Rr][Uu][Cc][Tt] ;
USING      : [Uu][Ss][Ii][Nn][Gg] ;
WITH       : [Ww][Ii][Tt][Hh] ;

INTEGER_VALUE : [0-9]+ ;

STRING
    : '\'' ( ~['\\] | '\\' . )* '\''
    | '"' ( ~["\\] | '\\' . )* '"'
    ;

IDENTIFIER
    : (LETTER | '_') (LETTER | DIGIT | '_')*
    ;

BACKQUOTED_IDENTIFIER
    : '`' ( ~'`' | '``' )* '`'
    ;

fragment LETTER : [a-zA-Z] ;
fragment DIGIT  : [0-9] ;

WS         : [ \r\n\t]+ -> channel(HIDDEN) ;
LINE_COMMENT : '--' ~[\r\n]* -> channel(HIDDEN) ;
BLOCK_COMMENT: '/*' .*? '*/' -> channel(HIDDEN) ;

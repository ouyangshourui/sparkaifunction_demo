#!/usr/bin/env bash
# 一键编译 Spark Catalyst 扩展 jar
# 输出：spark-extension/target/aifn-spark-extension-0.1.0.jar
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR/spark-extension"

if ! command -v mvn >/dev/null 2>&1; then
  echo "❌ 需要 Maven 3.9+（brew install maven 或下载 https://maven.apache.org/）"
  exit 1
fi

echo "▶ 编译 spark-extension（Scala 2.12 / Spark 3.5.3 / Iceberg 1.6.1）"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy 2>/dev/null || true
mvn -B -DskipTests clean package
echo ""
echo "✓ 产物：$DIR/spark-extension/target/aifn-spark-extension-0.1.0.jar"

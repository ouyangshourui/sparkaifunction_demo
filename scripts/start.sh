#!/usr/bin/env bash
# 一键启动后端 (FastAPI :49088) + 前端 (Vite :49193)
# 用法：bash scripts/start.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 0. 校验 .env
if [[ ! -f "$DIR/backend/.env" ]]; then
  echo "❌ 找不到 backend/.env，请先 cp .env.example backend/.env 并填入 SecretId/SecretKey"
  exit 1
fi

# 1. 编译 jar（不存在或显式 --rebuild 时重编）
JAR="$DIR/spark-extension/target/aifn-spark-extension-0.1.0.jar"
if [[ ! -f "$JAR" || "${1:-}" == "--rebuild" ]]; then
  echo "ℹ jar 不存在或要求重编，开始编译..."
  bash "$DIR/scripts/build.sh"
fi

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy 2>/dev/null || true

# 2. 后端 venv
if [[ ! -d "$DIR/backend/.venv" ]]; then
  echo "▶ 创建 backend/.venv"
  python3 -m venv "$DIR/backend/.venv"
  "$DIR/backend/.venv/bin/pip" install -q -U pip
  "$DIR/backend/.venv/bin/pip" install -q \
      "fastapi" "uvicorn[standard]" "python-dotenv" "pydantic-settings" \
      "pyspark==3.5.3" "pandas>=2.0" "pyarrow>=14" "packaging" "setuptools<70"
fi

# 3. distutils 兼容补丁（Python 3.12+ 删除了 distutils 模块）
PYSPARK_DIR="$DIR/backend/.venv/lib/python3.13/site-packages/pyspark"
[[ -d "$PYSPARK_DIR" ]] || PYSPARK_DIR="$DIR/backend/.venv/lib/python3.12/site-packages/pyspark"
if [[ -d "$PYSPARK_DIR" ]]; then
  if grep -rq "from distutils" "$PYSPARK_DIR" 2>/dev/null; then
    echo "▶ 修复 pyspark 内 distutils 引用"
    grep -rl "from distutils" "$PYSPARK_DIR" 2>/dev/null | while read f; do
      /usr/bin/sed -i '' 's|from distutils\.version import LooseVersion|from packaging.version import Version as LooseVersion|g' "$f"
    done
  fi
fi

# 4. 启动后端
echo "▶ 启动后端 (FastAPI :49088)"
( cd "$DIR/backend" && \
  "$DIR/backend/.venv/bin/python" -m uvicorn app.main:app \
    --host 127.0.0.1 --port 49088 --log-level info ) &
BACKEND_PID=$!

# 5. 启动前端
echo "▶ 启动前端 (Vite :49193)"
( cd "$DIR/frontend" && \
  ( [[ -d node_modules ]] || npm install ) && \
  npm run dev ) &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true" EXIT INT TERM

echo ""
echo "============================================================"
echo " ✅ 后端 http://127.0.0.1:49088   /api/health"
echo " ✅ 前端 http://127.0.0.1:49193   SQL Workbench"
echo "============================================================"

wait

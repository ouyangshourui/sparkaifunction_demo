#!/usr/bin/env bash
# AI Function Demo · 一键启动脚本（推荐使用）
#
# 设计原则：
#  - 不阻塞 shell：所有服务后台运行 + disown
#  - 可重入：重复跑会先 kill 旧进程再启
#  - 预检查：jar / venv / .env 缺一不可，缺时明确报错
#  - 端口选用高位非敏感：后端 49088 / 前端 49193
#  - 日志固定路径：/tmp/aifn-logs/{backend,frontend}.log
#
# 用法：
#   bash scripts/dev.sh              # 启动（默认）
#   bash scripts/dev.sh --rebuild    # 强制重编 jar
#   bash scripts/dev.sh stop         # 停止所有服务
#   bash scripts/dev.sh status       # 查看运行状态

set -euo pipefail

# —— 端口 / 路径 ——
BACKEND_PORT=49088
FRONTEND_PORT=49193
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAR="$DIR/spark-extension/target/aifn-spark-extension-0.1.0.jar"
ENV_FILE="$DIR/backend/.env"
VENV="$DIR/backend/.venv"
LOG_DIR="/tmp/aifn-logs"

# —— 颜色 ——
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
info() { echo -e "${DIM}▸${NC} $*"; }

# —— 子命令路由 ——
cmd="${1:-start}"
case "$cmd" in
  stop)
    info "停止所有服务"
    pkill -f "uvicorn app.main" 2>/dev/null && ok "backend killed" || info "backend 未运行"
    pkill -f "vite --port $FRONTEND_PORT" 2>/dev/null && ok "frontend killed" || info "frontend 未运行"
    exit 0
    ;;
  status)
    echo "=== 服务状态 ==="
    if curl -fsS --max-time 2 "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
      ok "backend  http://127.0.0.1:$BACKEND_PORT  $(curl -fsS http://127.0.0.1:$BACKEND_PORT/api/health)"
    else
      err "backend  http://127.0.0.1:$BACKEND_PORT  无响应"
    fi
    if curl -fsS --max-time 2 -I "http://127.0.0.1:$FRONTEND_PORT" >/dev/null 2>&1; then
      ok "frontend http://127.0.0.1:$FRONTEND_PORT"
    else
      err "frontend http://127.0.0.1:$FRONTEND_PORT 无响应"
    fi
    exit 0
    ;;
  --rebuild)
    REBUILD=1
    ;;
  start|"")
    REBUILD=0
    ;;
  *)
    err "未知命令: $cmd"
    echo "用法: bash scripts/dev.sh [start|stop|status|--rebuild]"
    exit 1
    ;;
esac

# —— 预检查 ——
echo "=== 预检查 ==="

# 1) Java（spark-extension 需要 JDK 17+）
if ! command -v java >/dev/null 2>&1; then
  err "未找到 java（需要 JDK 17+）"
  exit 1
fi
ok "java $(java -version 2>&1 | head -1 | awk -F'"' '{print $2}')"

# 2) Maven（编 jar 用）
if ! command -v mvn >/dev/null 2>&1; then
  err "未找到 mvn（brew install maven）"
  exit 1
fi
ok "mvn $(mvn -v 2>/dev/null | head -1 | awk '{print $3}')"

# 3) Node（前端 dev server 用）
if ! command -v node >/dev/null 2>&1; then
  err "未找到 node（推荐 brew install node 或 nvm）"
  exit 1
fi
ok "node $(node -v)"

# 4) backend/.env
if [[ ! -f "$ENV_FILE" ]]; then
  err "找不到 $ENV_FILE"
  echo "    需要创建并填入 HUNYUAN_API_KEY 等配置；样例见仓库根目录 .env.example"
  exit 1
fi
ok ".env 存在"

# 5) Python venv（backend 依赖隔离）
if [[ ! -d "$VENV" ]]; then
  warn "$VENV 不存在，自动创建..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -U pip
  "$VENV/bin/pip" install -q -r <(cat <<'PYDEPS'
fastapi==0.115.5
uvicorn[standard]==0.32.0
pyspark==3.5.1
pydantic==2.9.2
pydantic-settings==2.6.1
python-dotenv==1.0.1
sse-starlette==2.1.3
openai==1.50.0
httpx==0.27.2
pandas>=2.0
pyarrow>=14
packaging
PYDEPS
)
  ok "venv 已创建并装包"
else
  ok "venv 存在"
fi

# 6) jar（不存在或 --rebuild 时重编）
if [[ ! -f "$JAR" || "$REBUILD" == "1" ]]; then
  info "编译 spark-extension（不存在或 --rebuild）..."
  ( cd "$DIR/spark-extension" && mvn -B -q -DskipTests clean package )
  if [[ ! -f "$JAR" ]]; then
    err "编译完成但找不到 $JAR"
    exit 1
  fi
fi
ok "jar $(basename "$JAR") $(stat -f '%z' "$JAR" | awk '{printf "%.1fMB\n", $1/1024/1024}')"

mkdir -p "$LOG_DIR"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy 2>/dev/null || true

# —— 停掉旧进程（可重入）——
if pgrep -f "uvicorn app.main" >/dev/null 2>&1; then
  info "发现旧 backend，先 kill"
  pkill -f "uvicorn app.main" 2>/dev/null || true
fi
if pgrep -f "vite --port $FRONTEND_PORT" >/dev/null 2>&1; then
  info "发现旧 frontend，先 kill"
  pkill -f "vite --port $FRONTEND_PORT" 2>/dev/null || true
fi
sleep 1.5

# —— 启动后端 ——
echo ""
echo "=== 启动服务 ==="
info "backend → 后台 + disown · 日志 $LOG_DIR/backend.log"
( cd "$DIR/backend" && \
  nohup "$VENV/bin/python" -m uvicorn app.main:app \
    --host 127.0.0.1 --port "$BACKEND_PORT" --log-level warning \
    > "$LOG_DIR/backend.log" 2>&1 ) &
BACKEND_PID=$!
disown $BACKEND_PID 2>/dev/null || true

# 等 SparkSession + Iceberg 就绪
info "等待 backend 就绪（最多 30s）..."
for i in $(seq 1 30); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
    ok "backend ready · http://127.0.0.1:$BACKEND_PORT"
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    err "backend 30s 内未就绪，看日志：tail -50 $LOG_DIR/backend.log"
    exit 1
  fi
done

# —— 启动前端 ——
info "frontend → 后台 + disown · 日志 $LOG_DIR/frontend.log"
( cd "$DIR/frontend" && \
  ( [[ -d node_modules ]] || npm install --silent ) && \
  nohup npm run dev -- --port "$FRONTEND_PORT" \
    > "$LOG_DIR/frontend.log" 2>&1 ) &
FRONTEND_PID=$!
disown $FRONTEND_PID 2>/dev/null || true

info "等待 frontend 就绪（最多 15s）..."
for i in $(seq 1 15); do
  if curl -fsS --max-time 1 -I "http://127.0.0.1:$FRONTEND_PORT" >/dev/null 2>&1; then
    ok "frontend ready · http://127.0.0.1:$FRONTEND_PORT"
    break
  fi
  sleep 1
done

# —— 总结 ——
echo ""
echo "============================================================"
echo -e " ${GREEN}✅ AI Function Demo 已启动${NC}"
echo "============================================================"
echo "  Frontend  http://127.0.0.1:$FRONTEND_PORT"
echo "  Backend   http://127.0.0.1:$BACKEND_PORT/api/health"
echo "  Spark UI  http://127.0.0.1:4040  (首次 SQL 后才出现)"
echo ""
echo "  日志：tail -f $LOG_DIR/{backend,frontend}.log"
echo "  停止：bash scripts/dev.sh stop"
echo "  状态：bash scripts/dev.sh status"
echo "============================================================"

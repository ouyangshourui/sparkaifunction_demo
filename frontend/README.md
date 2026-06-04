# Frontend (React + Vite + TS)

## 技术栈
- React 18 / Vite 5 / TypeScript
- TailwindCSS（深色 Midnight×Teal，呼应 PPT）
- Monaco Editor（SQL 高亮）
- ECharts（监控可视化）
- React Router v6（4 Tab）

## 启动

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

Vite dev server 已配 `/api` 代理到后端 8000。

## 4 个 Tab

| Tab | 用途 |
|-----|------|
| Workbench | Monaco SQL 编辑器 + 4 段样例 SQL + EXPLAIN 看物理计划 |
| Functions | CREATE AI FUNCTION DDL 表单 + 已注册函数列表 |
| Monitor | Token 使用 / 路由分布饼图 / 模型调用次数 / 预算告警 |
| Recovery | 缓存条目数 / 清空缓存 / Replay / 演示步骤说明 |

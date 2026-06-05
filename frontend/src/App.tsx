import { Link, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import TryIt from "./pages/TryIt";
import Workspace from "./pages/Workspace";
import Insights from "./pages/Insights";
import Architecture from "./pages/Architecture";
import Settings from "./pages/Settings";
import StatusBar from "./components/StatusBar";

const NAV = [
  { to: "/", label: "Try It", desc: "60s Aha", icon: "🟢" },
  { to: "/workspace", label: "Workspace", desc: "SQL 工作台", icon: "🛠" },
  { to: "/insights", label: "Insights", desc: "省钱报表", icon: "📊" },
  { to: "/architecture", label: "Architecture", desc: "技术原理 · 零侵入", icon: "🧬" },
];

export default function App() {
  const loc = useLocation();
  const [sparkUiUrl, setSparkUiUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/spark-ui-url")
      .then((r) => r.json())
      .then((d) => setSparkUiUrl(d.url))
      .catch(() => setSparkUiUrl("http://127.0.0.1:4040"));
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* —— 品牌 + 主导航 —— */}
      <header className="bg-bgPanel border-b border-border px-6 py-2.5 flex items-center gap-6">
        <Link to="/" className="flex items-center gap-2">
          <div className="text-teal font-bold text-lg tracking-wider">AI · FUNCTION</div>
          <div className="text-textSub text-[11px] hidden md:block">
            Spark SQL · Catalyst Extension
          </div>
        </Link>

        <nav className="ml-auto flex gap-1 items-center">
          {NAV.map((n) => {
            const active = loc.pathname === n.to || (n.to === "/" && loc.pathname === "/try-it");
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`px-3 py-1.5 rounded text-sm transition flex items-center gap-1.5 ${
                  active
                    ? "bg-teal text-white"
                    : "text-textSub hover:bg-bgPanel2 hover:text-textMain"
                }`}
                title={n.desc}
              >
                <span className="text-xs">{n.icon}</span>
                {n.label}
              </Link>
            );
          })}

          {/* Settings 降级为齿轮 */}
          <Link
            to="/settings"
            className={`ml-2 w-8 h-8 rounded flex items-center justify-center transition ${
              loc.pathname === "/settings"
                ? "bg-teal text-white"
                : "text-textSub hover:bg-bgPanel2 hover:text-textMain"
            }`}
            title="Settings · ApiKey / 模型配置"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </Link>
        </nav>
      </header>

      {/* —— 全局状态条 —— */}
      <StatusBar sparkUiUrl={sparkUiUrl} />

      {/* —— 主内容 —— */}
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<TryIt />} />
          <Route path="/try-it" element={<TryIt />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/architecture" element={<Architecture />} />
          <Route path="/settings" element={<Settings />} />

          {/* 兼容旧链接 */}
          <Route path="/functions" element={<Workspace />} />
          <Route path="/monitor" element={<Insights />} />
          <Route path="/recovery" element={<Insights />} />
        </Routes>
      </main>
    </div>
  );
}

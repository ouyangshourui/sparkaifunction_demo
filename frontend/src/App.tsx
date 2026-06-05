import { Link, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import Workbench from "./pages/Workbench";
import Functions from "./pages/Functions";
import Monitor from "./pages/Monitor";
import Recovery from "./pages/Recovery";
import Settings from "./pages/Settings";

const NAV = [
  { to: "/", label: "Workbench" },
  { to: "/functions", label: "Functions" },
  { to: "/monitor", label: "Monitor" },
  { to: "/recovery", label: "Recovery" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const loc = useLocation();
  const [sparkUiUrl, setSparkUiUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/spark-ui-url")
      .then(r => r.json())
      .then(d => setSparkUiUrl(d.url))
      .catch(() => setSparkUiUrl("http://127.0.0.1:4040"));
  }, []);
  return (
    <div className="h-full flex flex-col">
      <header className="bg-bgPanel border-b border-border px-6 py-3 flex items-center gap-6">
        <div className="text-teal font-bold text-lg tracking-wider">
          AI · FUNCTION
        </div>
        <div className="text-textSub text-xs">Spark SQL · Catalyst Extension</div>
        <nav className="ml-auto flex gap-1">
          {NAV.map((n) => {
            const active = loc.pathname === n.to;
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`px-4 py-1.5 rounded text-sm transition ${
                  active
                    ? "bg-teal text-white"
                    : "text-textSub hover:bg-bgPanel2 hover:text-textMain"
                }`}
              >
                {n.label}
              </Link>
            );
          })}
          <a
            href={sparkUiUrl || "http://127.0.0.1:4040"}
            target="_blank"
            rel="noreferrer"
            className="ml-2 px-3 py-1.5 rounded text-sm text-textSub hover:bg-bgPanel2 hover:text-textMain flex items-center gap-1"
            title={sparkUiUrl ? `Spark UI (${sparkUiUrl.split(":").pop()})` : "Spark UI"}
          >
            {/* external-link icon */}
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Spark UI
          </a>
        </nav>
      </header>
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<Workbench />} />
          <Route path="/functions" element={<Functions />} />
          <Route path="/monitor" element={<Monitor />} />
          <Route path="/recovery" element={<Recovery />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

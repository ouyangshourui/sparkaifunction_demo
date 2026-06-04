import { Link, Route, Routes, useLocation } from "react-router-dom";
import Workbench from "./pages/Workbench";
import Functions from "./pages/Functions";
import Monitor from "./pages/Monitor";
import Recovery from "./pages/Recovery";

const NAV = [
  { to: "/", label: "Workbench" },
  { to: "/functions", label: "Functions" },
  { to: "/monitor", label: "Monitor" },
  { to: "/recovery", label: "Recovery" },
];

export default function App() {
  const loc = useLocation();
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
        </nav>
      </header>
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<Workbench />} />
          <Route path="/functions" element={<Functions />} />
          <Route path="/monitor" element={<Monitor />} />
          <Route path="/recovery" element={<Recovery />} />
        </Routes>
      </main>
    </div>
  );
}

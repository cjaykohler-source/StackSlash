import { Route, Routes } from "react-router-dom";
import { AuthGuard } from "./components/AuthGuard";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { SymbolDetail } from "./pages/SymbolDetail";
import { About } from "./pages/About";
import { Reports } from "./pages/Reports";
import { Settings } from "./pages/Settings";
import { Isolator } from "./pages/Isolator";
import { lazy, Suspense } from "react";
import { Research } from "./pages/Research";

// Charter pulls in ECharts (~1 MB); load it only when the page is opened.
const Charter = lazy(() => import("./pages/Charter").then((m) => ({ default: m.Charter })));
import { Ops } from "./pages/Ops";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <AuthGuard>
            <Dashboard />
          </AuthGuard>
        }
      />
      <Route
        path="/symbol/:ticker"
        element={
          <AuthGuard>
            <SymbolDetail />
          </AuthGuard>
        }
      />
      <Route
        path="/about"
        element={
          <AuthGuard>
            <About />
          </AuthGuard>
        }
      />
      <Route
        path="/reports"
        element={
          <AuthGuard>
            <Reports />
          </AuthGuard>
        }
      />
      <Route
        path="/isolator"
        element={
          <AuthGuard>
            <Isolator />
          </AuthGuard>
        }
      />
      <Route
        path="/charter"
        element={
          <AuthGuard>
            <Suspense fallback={<div className="page"><p className="empty-state">Loading Charter…</p></div>}>
              <Charter />
            </Suspense>
          </AuthGuard>
        }
      />
      <Route
        path="/research"
        element={
          <AuthGuard>
            <Research />
          </AuthGuard>
        }
      />
      <Route
        path="/ops"
        element={
          <AuthGuard>
            <Ops />
          </AuthGuard>
        }
      />
      <Route
        path="/settings"
        element={
          <AuthGuard>
            <Settings />
          </AuthGuard>
        }
      />
    </Routes>
  );
}

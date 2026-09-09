import { Route, Routes } from "react-router-dom";
import { AuthGuard } from "./components/AuthGuard";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { SymbolDetail } from "./pages/SymbolDetail";
import { About } from "./pages/About";
import { Reports } from "./pages/Reports";
import { Settings } from "./pages/Settings";
import { Isolator } from "./pages/Isolator";

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

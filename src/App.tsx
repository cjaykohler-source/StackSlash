import { Route, Routes } from "react-router-dom";
import { AuthGuard } from "./components/AuthGuard";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { SymbolDetail } from "./pages/SymbolDetail";
import { About } from "./pages/About";
import { Reports } from "./pages/Reports";

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
    </Routes>
  );
}

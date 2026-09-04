import { Route, Routes } from "react-router-dom";
import { AuthGuard } from "./components/AuthGuard";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { SymbolDetail } from "./pages/SymbolDetail";

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
    </Routes>
  );
}

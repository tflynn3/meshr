import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthBoundary } from "./auth/AuthBoundary";
import { AuthProvider } from "./auth/AuthContext";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <AuthBoundary>
        <App />
      </AuthBoundary>
    </AuthProvider>
  </StrictMode>,
);

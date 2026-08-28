import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ConsoleLangProvider } from "./i18n";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ConsoleLangProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
      </ConsoleLangProvider>
    </BrowserRouter>
  </StrictMode>,
);

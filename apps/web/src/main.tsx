import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App.js";
import { initializeTheme } from "./components/ThemeControl.js";
import "./ui/tokens.css";
import "./ui/base.css";
import "./styles.css";
import "./ui/product-shell.css";
import "./ui/channels.css";
import "./ui/mission-control.css";

initializeTheme();

const rootElement = document.getElementById("root");
if (rootElement !== null) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

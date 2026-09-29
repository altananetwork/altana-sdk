import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/components.css";
import { Root } from "./Root";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root storage={window.localStorage} env={import.meta.env as Record<string, string | undefined>} />
  </StrictMode>,
);

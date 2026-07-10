import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

const storedTheme = JSON.parse(localStorage.getItem("infinite-canvas:theme_store") || "{}") as { state?: { theme?: string } };
const dark = storedTheme.state?.theme !== "light";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

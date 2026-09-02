import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { registerServiceWorker } from "./pwa/update.js";

// The app-shell service worker (#44): registers unconditionally, and is
// itself a no-op wherever there's nothing to register against (`vite dev`,
// an old browser) — see its own docstring.
registerServiceWorker();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error('index.html is missing its "#root" element.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

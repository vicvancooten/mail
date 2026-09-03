import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { registerServiceWorker } from "./pwa/update.js";
import { applyTheme, readTheme } from "./theme/device-theme.js";

// The app-shell service worker (#44): registers unconditionally, and is
// itself a no-op wherever there's nothing to register against (`vite dev`,
// an old browser) — see its own docstring.
registerServiceWorker();

// Applied before the first paint, not from an effect inside `RootLayout`:
// Appearance is a Device Preference already sitting in `localStorage` (#72),
// so there is no round trip to wait on, and waiting for React to mount would
// flash the OS default first on every cold load and reload.
applyTheme(readTheme());

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error('index.html is missing its "#root" element.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

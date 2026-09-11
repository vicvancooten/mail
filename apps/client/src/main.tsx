import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { startNotificationRouter } from "./pwa/notification-router.js";
import { registerServiceWorker } from "./pwa/update.js";
import { applyTheme, readTheme, syncThemeWithSystem } from "./theme/device-theme.js";

// The app-shell service worker (#44): registers unconditionally, and is
// itself a no-op wherever there's nothing to register against (`vite dev`,
// an old browser) — see its own docstring.
registerServiceWorker();

// The main-thread half of a notification click reaching an already-open
// window (#53, #151): `sw.ts#focusOrOpenClient` posts `{type:
// "notification-click", target}` to the focused client; this is what turns
// that message into `MailSection`/`RootLayout`'s own routing via
// `publishNotificationTarget`.
startNotificationRouter();

// Applied before the first paint, not from an effect inside `RootLayout`:
// Appearance is a Device Preference already sitting in `localStorage` (#72),
// so there is no round trip to wait on, and waiting for React to mount would
// flash the OS default first on every cold load and reload.
applyTheme(readTheme());

// While the stored preference is `system`, keeps the meta/document classes
// moving with the OS if it flips scheme with the tab already open (#287) —
// `index.html`'s inline script already answered the cold-load case, before
// this bundle ever ran.
syncThemeWithSystem();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error('index.html is missing its "#root" element.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

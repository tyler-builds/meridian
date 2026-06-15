import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";

import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import App from "./App";
import { SettingsProvider } from "./lib/settings";
import { initPersistence } from "./lib/persist";

// Forward uncaught JS errors and unhandled promise rejections to the Rust log
// file, so frontend failures survive the webview (the devtools console is gone
// once the app dies). Errors in the forwarding itself are swallowed — logging
// must never cascade.
const reportError = (message: string) => {
  void invoke("frontend_log", {
    level: "error",
    message: message.slice(0, 2000),
  }).catch(() => {});
};
window.addEventListener("error", (e) => {
  reportError(
    `uncaught: ${e.message} @ ${e.filename ?? "?"}:${e.lineno ?? 0}:${e.colno ?? 0}`,
  );
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  reportError(
    `unhandledrejection: ${r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r)}`,
  );
});

// Note: StrictMode is intentionally omitted. Its double-mount in development
// would spawn (and orphan) duplicate PTY processes per terminal.
//
// Hydrate persisted state from the app-data-dir file before the first render so
// settings and the session restore synchronously (and survive the dev/prod
// origin change that plain localStorage would not).
void initPersistence().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <SettingsProvider>
      <App />
    </SettingsProvider>,
  );
});

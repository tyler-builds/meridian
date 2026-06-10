import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import App from "./App";
import { SettingsProvider } from "./lib/settings";
import { initPersistence } from "./lib/persist";

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

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";
const STORAGE_KEY = "artoo.theme";
const THEME_EVENT = "artoo:theme-change";
const readTheme = (): Theme => document.documentElement.dataset.theme === "light" ? "light" : "dark";
function subscribeTheme(listener: () => void): () => void {
  const storage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    initializeTheme();
    listener();
  };
  window.addEventListener(THEME_EVENT, listener);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(THEME_EVENT, listener); window.removeEventListener("storage", storage); };
}

export function initializeTheme(): Theme {
  let theme: Theme = "dark";
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === "light") theme = "light";
  } catch { /* The theme still works when browser storage is disabled. */ }
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function ThemeControl(): React.ReactNode {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "dark" as const);
  function toggle(): void {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* Session-only theme. */ }
    window.dispatchEvent(new Event(THEME_EVENT));
  }
  return <button type="button" className="os-icon-button" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
    {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
  </button>;
}

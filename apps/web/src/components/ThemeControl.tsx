import { useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";
const STORAGE_KEY = "artoo.theme";

export function initializeTheme(): Theme {
  let theme: Theme = "dark";
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === "light") theme = "light";
  } catch { /* The theme still works when browser storage is disabled. */ }
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function ThemeControl(): React.ReactNode {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === "light" ? "light" : "dark");
  function toggle(): void {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* Session-only theme. */ }
    setTheme(next);
  }
  return <button type="button" className="os-icon-button" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
    {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
  </button>;
}

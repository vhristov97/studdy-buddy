import { useState } from "react";
import { applyTheme, nextTheme, readStoredTheme, storeTheme, type Theme } from "../theme/theme";
import styles from "./ThemeToggle.module.css";

const LABELS: Record<Theme, string> = {
  system: "Sistemska tema",
  light: "Svetla tema",
  dark: "Tamna tema",
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  function cycle() {
    const next = nextTheme(theme);
    setTheme(next);
    applyTheme(next);
    storeTheme(next);
  }

  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={cycle}
      aria-label={`Tema: ${LABELS[theme]}. Kliknite za promenu.`}
      data-theme-mode={theme}
    >
      {LABELS[theme]}
    </button>
  );
}

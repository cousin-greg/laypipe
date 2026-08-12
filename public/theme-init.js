try {
  const theme = localStorage.getItem("laypipe-theme");
  if (
    theme === "dark" ||
    (!theme && matchMedia("(prefers-color-scheme: dark)").matches)
  ) {
    document.documentElement.dataset.theme = "dark";
  }
} catch {}

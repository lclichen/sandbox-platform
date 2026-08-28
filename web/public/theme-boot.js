// 首屏前应用上次选择的主题，避免闪烁。（外部文件：CSP script-src 'self' 允许）
try {
  var t = localStorage.getItem("amedac-console-theme");
  if (t) document.documentElement.dataset.theme = t;
} catch (e) {}

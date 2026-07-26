// 主题预加载：在 React 和 CSS 加载之前，根据 localStorage 设置 data-theme，
// 避免深色主题用户在启动时看到白屏闪烁。
// 该脚本必须同步执行，放在 <head> 中且在样式表之前。
(function () {
  try {
    var t = localStorage.getItem("theme") || "system";
    var resolved;
    if (t === "system") {
      resolved =
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    } else {
      resolved = t === "dark" ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", resolved);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();

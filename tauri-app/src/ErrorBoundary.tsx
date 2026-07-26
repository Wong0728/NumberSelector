import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 全局错误边界：捕获子组件渲染/生命周期中的错误，避免直接白屏。
 * 若捕获到错误，显示可操作的错误信息，方便用户反馈和调试。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleCopy = async () => {
    const text = `${this.state.error?.name}: ${this.state.error?.message}\n${this.state.error?.stack}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 降级方案
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      try {
        textarea.select();
        document.execCommand("copy");
      } finally {
        document.body.removeChild(textarea);
      }
    }
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const error = this.state.error;

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg, #f5f5f5)",
          color: "var(--text, #222)",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: 560,
            width: "100%",
            background: "var(--surface, #fff)",
            borderRadius: 12,
            padding: "28px 32px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
          }}
        >
          <h2 style={{ margin: "0 0 12px", fontSize: 20 }}>
            程序遇到了错误
          </h2>
          <p style={{ margin: "0 0 20px", lineHeight: 1.6, opacity: 0.85 }}>
            很抱歉，界面渲染时出现了异常。请尝试重启程序，或联系开发者反馈以下信息。
          </p>

          <div
            style={{
              background: "rgba(0,0,0,0.04)",
              borderRadius: 8,
              padding: 12,
              fontSize: 13,
              fontFamily: "monospace",
              wordBreak: "break-word",
              maxHeight: 200,
              overflow: "auto",
              marginBottom: 20,
            }}
          >
            {error?.name}: {error?.message}
            <br />
            {error?.stack}
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={this.handleReload}
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                border: "none",
                background: "var(--info)",
                color: "var(--accent-text)",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              刷新重试
            </button>
            <button
              onClick={this.handleCopy}
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                border: "1px solid var(--border-strong, #bdbdbd)",
                background: "transparent",
                color: "var(--text, #222)",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              复制错误信息
            </button>
          </div>
        </div>
      </div>
    );
  }
}

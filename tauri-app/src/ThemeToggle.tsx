import { ThemeSetting } from "./useTheme";

const ORDER: ThemeSetting[] = ["light", "dark", "system"];

const ICONS: Record<
  ThemeSetting,
  { icon: JSX.Element; label: string }
> = {
  light: {
    label: "浅色",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="4" fill="currentColor" />
        <path
          d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  dark: {
    label: "深色",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
          fill="currentColor"
        />
      </svg>
    ),
  },
  system: {
    label: "跟随系统",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect
          x="2"
          y="4"
          width="20"
          height="14"
          rx="2"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M8 22h8M12 18v4"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
};

interface ThemeToggleProps {
  value: ThemeSetting;
  onChange: (theme: ThemeSetting) => void;
}

export default function ThemeToggle({ value, onChange }: ThemeToggleProps) {
  const handleClick = () => {
    const idx = ORDER.indexOf(value);
    const next = ORDER[(idx + 1) % ORDER.length];
    onChange(next);
  };

  const current = ICONS[value];
  return (
    <button
      type="button"
      className="theme-toggle-button"
      onClick={handleClick}
      title={`当前：${current.label}（点击切换）`}
      aria-label={`当前主题：${current.label}，点击切换`}
    >
      {current.icon}
    </button>
  );
}

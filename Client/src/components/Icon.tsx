interface IconProps {
  name: string;
  size?: number;
  className?: string;
}

// Minimal inline SVG icon set (stroke-based, inherits currentColor).
const PATHS: Record<string, JSX.Element> = {
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  queue: (
    <>
      <rect x="3" y="5" width="18" height="4" rx="1" />
      <rect x="3" y="11" width="18" height="4" rx="1" />
      <rect x="3" y="17" width="12" height="4" rx="1" />
    </>
  ),
  bucket: (
    <>
      <path d="M4 7h16l-1.5 13a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8L4 7z" />
      <path d="M9 7a3 3 0 0 1 6 0" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2 20h20L12 3z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  check: <path d="M5 13l4 4L19 7" />,
  spinner: <path d="M12 3a9 9 0 1 0 9 9" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  github: (
    <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6A4.6 4.6 0 0 0 19 7.5 4.3 4.3 0 0 0 18.8 4S17.7 3.7 15 5.3a13.4 13.4 0 0 0-6 0C6.3 3.7 5.2 4 5.2 4A4.3 4.3 0 0 0 5 7.5 4.6 4.6 0 0 0 3.5 11c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V23" />
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
};

export default function Icon({ name, size = 20, className }: IconProps) {
  const content = PATHS[name] ?? PATHS.server;
  const spin = name === "spinner";
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={spin ? { animation: "b3spin 0.9s linear infinite" } : undefined}
      aria-hidden="true"
    >
      {content}
    </svg>
  );
}

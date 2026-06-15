import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import type { DeploymentEvent } from "../types";

interface LogTerminalProps {
  events: DeploymentEvent[];
  streaming?: boolean;
  height?: number;
}

const ROW_HEIGHT = 28;
const OVERSCAN = 8;

export function LogTerminal({ events, streaming = false, height = 520 }: LogTerminalProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return events;
    return events.filter((event) => `${event.level} ${event.message} ${event.serviceId ?? ""}`.toLowerCase().includes(normalized));
  }, [events, query]);

  const totalHeight = filtered.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(filtered.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visible = filtered.slice(startIndex, endIndex);

  useEffect(() => {
    if (!follow || !viewportRef.current) return;
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  }, [filtered.length, follow]);

  return (
    <section className="overflow-hidden rounded-[30px] border border-white/5 bg-[#08080C] shadow-tactile">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 bg-white/[0.03] px-4 py-3 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-rose-400/80" />
            <span className="h-3 w-3 rounded-full bg-amber-300/80" />
            <span className="h-3 w-3 rounded-full bg-emerald-400/80" />
          </div>
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-white/35">Live build logs</p>
            <p className="font-mono text-xs text-cyan-200/70">{filtered.length} lines indexed</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search logs"
            className="h-9 w-44 rounded-xl border border-white/5 bg-white/[0.04] px-3 font-mono text-xs text-white outline-none transition-all duration-200 placeholder:text-white/25 focus:border-cyan-300/40 focus:ring-2 focus:ring-cyan-300/10"
          />
          <button
            type="button"
            onClick={() => setFollow((value) => !value)}
            className={clsx(
              "h-9 rounded-xl border px-3 font-mono text-xs transition-all duration-200",
              follow ? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100" : "border-white/5 bg-white/[0.03] text-white/50"
            )}
          >
            {follow ? "Following" : "Scroll to bottom"}
          </button>
        </div>
      </header>
      <div
        ref={viewportRef}
        className="relative overflow-auto font-mono text-[13px] leading-7 text-white/70"
        style={{ height }}
        onScroll={(event) => {
          const target = event.currentTarget;
          setScrollTop(target.scrollTop);
          const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
          setFollow(nearBottom);
        }}
      >
        <div style={{ height: totalHeight }}>
          <div style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}>
            {visible.map((event) => (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                className="grid grid-cols-[92px_72px_minmax(0,1fr)] gap-3 border-b border-white/[0.025] px-4"
                style={{ height: ROW_HEIGHT }}
              >
                <span className="text-white/30">{formatTime(event.timestamp)}</span>
                <span className={levelClass(event.level)}>{event.level}</span>
                <span className="truncate" dangerouslySetInnerHTML={{ __html: colorizeAnsi(event.ansi || event.message) }} />
              </motion.div>
            ))}
          </div>
        </div>
        {streaming && <span className="sticky bottom-3 left-4 inline-block h-4 w-2 animate-cursor bg-cyan-200" />}
      </div>
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], { hour12: false });
}

function levelClass(level: DeploymentEvent["level"]): string {
  const base = "font-semibold uppercase tracking-[0.16em]";
  if (level === "error") return `${base} text-rose-300`;
  if (level === "warn") return `${base} text-amber-300`;
  if (level === "success") return `${base} text-emerald-300`;
  if (level === "debug") return `${base} text-violet-300`;
  return `${base} text-cyan-200`;
}

function colorizeAnsi(input: string): string {
  return escapeHtml(input)
    .replace(/\u001b\[32m/g, '<span class="text-emerald-300">')
    .replace(/\u001b\[36m/g, '<span class="text-cyan-200">')
    .replace(/\u001b\[33m/g, '<span class="text-amber-300">')
    .replace(/\u001b\[31m/g, '<span class="text-rose-300">')
    .replace(/\u001b\[35m/g, '<span class="text-violet-300">')
    .replace(/\u001b\[0m/g, "</span>");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

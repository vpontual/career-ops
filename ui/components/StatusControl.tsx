"use client";

import { useState, useTransition } from "react";

const OPTIONS: { value: string; label: string; color: string }[] = [
  { value: "under_review", label: "Under review", color: "text-amber-300 border-amber-400/40 bg-amber-500/10" },
  { value: "applied",      label: "Applied",      color: "text-sky-300 border-sky-400/40 bg-sky-500/10" },
  { value: "rejected",     label: "Rejected",     color: "text-red-300 border-red-400/40 bg-red-500/10" },
  { value: "archived",     label: "Archived",     color: "text-zinc-400 border-zinc-600 bg-zinc-800/40" },
  { value: "clear",        label: "Clear",        color: "text-zinc-500 border-zinc-700 bg-transparent" }
];

interface Props {
  url: string;
  company: string;
  role: string;
  current: string;
}

const CURRENT_STYLE: Record<string, string> = {
  new:          "text-zinc-500 border-zinc-700",
  under_review: "text-amber-300 border-amber-400/40 bg-amber-500/10",
  applied:      "text-sky-300 border-sky-400/40 bg-sky-500/10",
  rejected:     "text-red-300 border-red-400/40 bg-red-500/10",
  archived:     "text-zinc-400 border-zinc-600 bg-zinc-800/40"
};

const CURRENT_LABEL: Record<string, string> = {
  new:          "new",
  under_review: "review",
  applied:      "applied",
  rejected:     "rejected",
  archived:     "archived"
};

export default function StatusControl({ url, company, role, current }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function setStatus(value: string) {
    setError(null);
    setOpen(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, status: value, company, role })
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(j.error || `HTTP ${res.status}`);
          return;
        }
        // Server revalidates "/" so a soft refresh shows updated state.
        window.location.reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
      }
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o); }}
        disabled={pending}
        className={
          "text-[10px] font-mono border rounded px-1.5 py-0.5 transition " +
          (CURRENT_STYLE[current] ?? CURRENT_STYLE.new) +
          (pending ? " opacity-50" : " hover:brightness-125")
        }
        title="Change status"
      >
        {pending ? "…" : (CURRENT_LABEL[current] ?? current)} ▾
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-10 w-36 rounded-md border border-zinc-700 bg-zinc-950 shadow-lg shadow-black/50">
          {OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatus(opt.value)}
              className={`w-full text-left text-[11px] font-mono px-3 py-1.5 hover:bg-zinc-800 ${
                opt.value === "clear" ? "text-zinc-500 border-t border-zinc-800" : ""
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="absolute right-0 mt-1 z-10 w-44 text-[10px] font-mono text-red-400 bg-zinc-950 border border-red-500/40 rounded px-2 py-1">
          {error}
        </div>
      )}
    </div>
  );
}

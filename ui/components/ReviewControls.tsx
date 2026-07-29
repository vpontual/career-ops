"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const CHOICES: { id: string; label: string; on: string; off: string }[] = [
  {
    id: "approved",
    label: "Approve",
    on: "bg-emerald-500/25 border-emerald-400 text-emerald-100",
    off: "bg-slate-900 border-slate-700 text-slate-400 hover:border-emerald-400/60 hover:text-emerald-200"
  },
  {
    id: "hold",
    label: "Hold",
    on: "bg-amber-500/25 border-amber-400 text-amber-100",
    off: "bg-slate-900 border-slate-700 text-slate-400 hover:border-amber-400/60 hover:text-amber-200"
  },
  {
    id: "rejected",
    label: "Reject",
    on: "bg-rose-500/25 border-rose-400 text-rose-100",
    off: "bg-slate-900 border-slate-700 text-slate-400 hover:border-rose-400/60 hover:text-rose-200"
  }
];

export default function ReviewControls({
  slug,
  decision
}: {
  slug: string;
  decision: string | null;
}) {
  const [current, setCurrent] = useState<string | null>(decision);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function choose(id: string) {
    const next = current === id ? "clear" : id;
    const previous = current;
    setCurrent(next === "clear" ? null : id);
    setError(null);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, decision: next })
      });
      if (!res.ok) throw new Error(String(res.status));
      startTransition(() => router.refresh());
    } catch {
      setCurrent(previous);
      setError("save failed");
    }
  }

  return (
    <div className="flex items-center gap-2">
      {CHOICES.map(c => (
        <button
          key={c.id}
          onClick={() => choose(c.id)}
          disabled={pending}
          className={`px-3 py-1.5 rounded-md border text-xs font-medium transition disabled:opacity-50 ${
            current === c.id ? c.on : c.off
          }`}
        >
          {c.label}
        </button>
      ))}
      {error && <span className="text-xs text-rose-300 font-mono">{error}</span>}
    </div>
  );
}

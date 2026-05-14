"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  url: string;
  company: string;
  role: string;
}

export default function ApplyButton({ url, company, role }: Props) {
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function markApplied() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, status: "applied", company, role }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(j.error || `HTTP ${res.status}`);
          return;
        }
        setDone(true);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
      }
    });
  }

  if (done) {
    return (
      <span className="px-4 py-2 bg-blue-500/15 border border-blue-400/60 text-blue-200 rounded-md text-sm font-medium">
        ✓ Marked as applied
      </span>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={markApplied}
        disabled={pending}
        className="px-4 py-2 bg-blue-500/15 border border-blue-400/60 text-blue-200 rounded-md hover:bg-blue-500/30 transition text-sm font-medium disabled:opacity-50"
      >
        {pending ? "Saving…" : "✓ Mark as Applied"}
      </button>
      {error && <p className="mt-1 text-xs text-red-400 font-mono">{error}</p>}
    </div>
  );
}

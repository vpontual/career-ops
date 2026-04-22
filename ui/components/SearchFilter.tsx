"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

// SearchFilter: text input with Ctrl+K focus, Escape blur/clear, kbd badge.
// Writes the query to URL ?q=... so the server component can filter rows.
//
// Convention from /home/vp/design-system docs/components/search-bar:
//   - Ctrl+K / Cmd+K focuses
//   - Escape blurs and closes
//   - Kbd badge shown when empty
//   - 250-300ms debounce before triggering the URL update
export default function SearchFilter({ initial = "" }: { initial?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initial);
  const [isPending, startTransition] = useTransition();
  const [focused, setFocused] = useState(false);

  // Global Ctrl+K / Cmd+K focuses; Escape blurs and clears.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === "Escape" && document.activeElement === inputRef.current) {
        inputRef.current?.blur();
        if (value) {
          setValue("");
          updateUrl("");
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function updateUrl(next: string) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next.trim()) params.set("q", next.trim());
    else params.delete("q");
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  // Debounced URL push. 280ms per design system spec.
  useEffect(() => {
    const t = setTimeout(() => {
      const current = searchParams?.get("q") ?? "";
      if (value.trim() !== current) updateUrl(value);
    }, 280);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const showBadge = !focused && value.length === 0;

  return (
    <div className="relative w-72 shrink-0">
      <input
        ref={inputRef}
        type="text"
        placeholder="Filter by company or role…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label="Search roles"
        className="w-full px-3 py-1.5 pr-14 text-sm rounded-md bg-slate-800 border border-slate-600 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
      />
      {showBadge && (
        <kbd className="absolute right-2 top-1/2 -translate-y-1/2 hidden md:inline-flex items-center text-[10px] font-mono text-slate-400 border border-slate-600 rounded px-1.5 py-0.5 bg-slate-900 whitespace-nowrap leading-none">
          Ctrl K
        </kbd>
      )}
      {isPending && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-slate-500">…</span>
      )}
    </div>
  );
}

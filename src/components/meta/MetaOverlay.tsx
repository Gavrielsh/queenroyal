"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Full-screen modal shell shared by the wheel, chest and level-up moments: dimmed backdrop,
 * rotating sunburst, Escape / backdrop-click to close (unless `locked`, e.g. mid-spin).
 */
export function MetaOverlay({
  labelledBy,
  onClose,
  locked = false,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  locked?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [locked, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto overflow-x-hidden bg-[#0e0420]/85 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <div aria-hidden="true" className="qr-sunburst" />
      <div className="relative w-full max-w-md">{children}</div>
    </div>
  );
}

/** "Preview" pill shown on every surface rendered from demo data. */
export function PreviewBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-pending/50 bg-pending/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-pending ${className}`}
    >
      Preview
    </span>
  );
}

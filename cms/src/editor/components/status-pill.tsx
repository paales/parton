"use client"

import { useEffect, useRef, useState } from "react"
import { Icon } from "./icon.tsx"

type Status = "draft" | "preview" | "published"

const TONE: Record<Status, "amber" | "blue" | "green"> = {
  draft: "amber",
  preview: "blue",
  published: "green",
}

const LABEL: Record<Status, string> = {
  draft: "Draft",
  preview: "Preview",
  published: "Published",
}

/**
 * Status pill at the right of the toolbar. The dot color reflects the
 * current state; clicking opens a small menu to switch between Draft,
 * Preview, and Published (the design lets users move between states
 * without leaving the editor — the actual mode-change wiring is out
 * of scope, this surface just persists the selection).
 */
export function StatusPill({
  current = "draft",
  onChange,
}: {
  current?: Status
  onChange?: (next: Status) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const tone = TONE[current]
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="cms-toolbar-pill"
        onClick={() => setOpen((o) => !o)}
        title="Status"
        style={{ border: 0, font: "inherit" }}
      >
        <span className="cms-toolbar-status-dot" data-tone={tone} />
        <span>{LABEL[current]}</span>
        <Icon name="chevDown" size={14} />
      </button>
      {open && (
        <div className="cms-status-menu" role="menu">
          {(["draft", "preview", "published"] as const).map((s) => (
            <a
              key={s}
              href="#"
              className="cms-status-menu-item"
              onClick={(e) => {
                e.preventDefault()
                setOpen(false)
                onChange?.(s)
              }}
            >
              <span className="cms-toolbar-status-dot" data-tone={TONE[s]} />
              <span>{LABEL[s]}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

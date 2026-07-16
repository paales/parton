"use client"

import { useTransition } from "react"
import { toggleBareRoot } from "../pages/bare-root-actions.ts"

/**
 * The bare-root-parton fixture's checkbox: it invokes the server
 * function that writes the parton's cell. The parton re-renders because
 * it RESOLVED that cell — nothing here targets the parton itself.
 */
export function BareRootToggle({ checked }: { checked: boolean }) {
  const [pending, startTransition] = useTransition()
  return (
    <input
      type="checkbox"
      data-testid="bare-root-toggle"
      data-pending={pending}
      checked={checked}
      onChange={() => startTransition(() => void toggleBareRoot(!checked))}
    />
  )
}

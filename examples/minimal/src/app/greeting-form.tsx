"use client"

/**
 * `setGreeting` arrives as a bound server reference (a plain prop) — the
 * client calls it directly, no fetch/serialization boilerplate. The
 * form action re-renders `GreetingPage` on the server with the new
 * cell value.
 */
import { useState } from "react"

export function GreetingForm({
  greeting,
  setGreeting,
}: {
  greeting: string
  setGreeting: (value: string) => Promise<void>
}) {
  const [value, setValue] = useState(greeting)
  return (
    <form action={() => setGreeting(value)}>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Say something" />
      <button type="submit">Save</button>
    </form>
  )
}

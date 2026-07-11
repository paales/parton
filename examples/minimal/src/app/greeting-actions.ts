"use server"

/**
 * Writes are plain server functions — no action option on `parton`.
 * Import the cell, call `.set`; the framework fans the write back out
 * to every parton that read it (here: `GreetingPage`, via
 * `greeting.resolve()`).
 */
import { greeting } from "./greeting-state.ts"

export async function setGreeting(value: string): Promise<void> {
  await greeting.set(value)
}

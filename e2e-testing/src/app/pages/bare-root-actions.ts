"use server"

/**
 * The write half of the bare-root-parton fixture — a plain server
 * function. `bareRootToggle.set` fires the cell's signal, which wakes
 * the bare root parton that resolved it: the one dependency it has.
 */

import { bareRootToggle } from "./bare-root-state.ts"

export async function toggleBareRoot(next: boolean): Promise<void> {
  await bareRootToggle.set(next)
}

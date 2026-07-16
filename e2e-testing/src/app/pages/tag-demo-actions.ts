"use server"

/**
 * /tag-demo server actions — the write half of the tag idiom: the
 * demo's buttons invoke `bumpTag`, whose `refreshSelector(name)`
 * re-renders every parton that read `tag(name)`.
 */

import { refreshSelector } from "@parton/framework"

export async function bumpTag(name: string): Promise<void> {
  refreshSelector(name)
}

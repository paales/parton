"use server"

/**
 * Live-price refresh actions — the write half of the price tag idiom.
 * Every `LivePrice` placement reads `tag("price?sku=<sku>")`: the
 * bare-name bump refreshes every card, the sku-constrained bump
 * exactly one.
 */

import { refreshSelector } from "@parton/framework"

export async function bumpPrice(sku: string): Promise<void> {
  refreshSelector(`price?sku=${encodeURIComponent(sku)}`)
}

export async function bumpAllPrices(): Promise<void> {
  refreshSelector("price")
}

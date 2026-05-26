"use client"

import { useState, useTransition } from "react"
import { Button } from "@parton/copies/components/ui/button"
import { Alert, AlertDescription } from "@parton/copies/components/ui/alert"
import { updateLineQty, removeFromCart } from "./cart-line-actions.ts"

export function CartLineControls({ uid, quantity }: { uid: string; quantity: number }) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function changeQty(delta: number) {
    setError(null)
    const next = quantity + delta
    if (next < 0) return
    startTransition(async () => {
      try {
        if (next === 0) {
          await removeFromCart(uid)
        } else {
          await updateLineQty(uid, next)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  function remove() {
    setError(null)
    startTransition(async () => {
      try {
        await removeFromCart(uid)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => changeQty(-1)}
        disabled={isPending}
        data-testid={`cart-line-qty-down-${uid}`}
      >
        −
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => changeQty(+1)}
        disabled={isPending}
        data-testid={`cart-line-qty-up-${uid}`}
      >
        +
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={remove}
        disabled={isPending}
        data-testid={`cart-line-remove-${uid}`}
      >
        ✕
      </Button>
      {error && (
        <Alert variant="destructive" className="ml-2 py-1">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

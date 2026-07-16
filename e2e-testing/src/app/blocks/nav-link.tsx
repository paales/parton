/**
 * Nav link — single anchor inside `app-nav`'s `links` slot.
 *
 * Hrefs carrying the `?editor=1` convention render through
 * `EditorOpenNavLink` so the click flips the editor cookie alongside
 * the navigation; the URL param alone is server-side no-op.
 */

import { block, type RenderArgs } from "@parton/framework"
import { EditorOpenNavLink } from "@parton/cms"
import { buttonVariants } from "@parton/copies/components/ui/button"
import { NavLinkActive } from "../components/nav-link-active.tsx"

const OPEN_EDITOR_HREF = /[?&]editor=1(?:&|$)/

export const NavLinkBlock = block(
  function NavLinkRender({ href, label }: { href: string; label: string } & RenderArgs) {
    const className = buttonVariants({ variant: "ghost", size: "sm" })
    if (OPEN_EDITOR_HREF.test(href)) {
      return (
        <EditorOpenNavLink href={href} className={className}>
          {label}
        </EditorOpenNavLink>
      )
    }
    return <NavLinkActive href={href} label={label} className={className} />
  },
  {
    schema: ({ cms }) => ({
      href: cms.text("href"),
      label: cms.text("label"),
    }),
  },
)

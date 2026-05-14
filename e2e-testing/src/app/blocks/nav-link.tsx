/**
 * Nav link — single anchor inside `app-nav`'s `links` slot.
 *
 * Hrefs carrying the `?editor=1` convention render through
 * `EditorOpenNavLink` so the click flips the editor cookie alongside
 * the navigation; the URL param alone is server-side no-op.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { EditorOpenNavLink } from "@react-cms/cms"
import { buttonVariants } from "@react-cms/copies/components/ui/button"

const OPEN_EDITOR_HREF = /[?&]editor=1(?:&|$)/

export const NavLinkBlock = ReactCms.block(
  function NavLinkRender({ href, label }: { href: string; label: string } & RenderArgs) {
    const className = buttonVariants({ variant: "ghost", size: "sm" })
    if (OPEN_EDITOR_HREF.test(href)) {
      return (
        <EditorOpenNavLink href={href} className={className}>
          {label}
        </EditorOpenNavLink>
      )
    }
    return (
      <a href={href} className={className}>
        {label}
      </a>
    )
  },
  {
    selector: ".nav-item",
    schema: ({ cms }) => ({
      href: cms.text("href"),
      label: cms.text("label"),
    }),
  },
)

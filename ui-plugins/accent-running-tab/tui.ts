import { CliRenderEvents, type RGBA } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"

// Share of the theme accent blended into the tab background.
const TINT = 0.22
// Rescan the renderable tree at most this often.
const RESCAN_MS = 100

type Theme = {
  background: { base: RGBA }
  hue: { accent: Record<number, RGBA> }
}

function accentTint(theme: Theme): RGBA {
  const base = theme.background.base.toInts()
  const accent = theme.hue.accent[200].toInts()
  const mix = (index: number) =>
    Math.round(base[index]! + (accent[index]! - base[index]!) * TINT)
  const Color = theme.background.base.constructor as {
    fromInts: (r: number, g: number, b: number) => RGBA
  }
  return Color.fromInts(mix(0), mix(1), mix(2))
}

export default Plugin.define({
  id: "local.accent-running-tab",
  setup(context) {
    // Original tab background to restore when a session stops running.
    const originals = new Map<object, RGBA>()
    let lastScan = 0

    const apply = () => {
      const now = Date.now()
      if (now - lastScan < RESCAN_MS) return
      lastScan = now

      const theme = context.theme as unknown as Theme
      const live = new Set<object>()
      let tint: RGBA | undefined

      const scan = (node: any) => {
        if (node.isDestroyed) return
        const children = node.getChildren?.() ?? []
        const pulse = children.find(
          (child: any) =>
            typeof child.id === "string" && child.id.startsWith("tab_pulse-"),
        )
        if (pulse) {
          live.add(node)
          // The host sets `active` for a session that is running and does not
          // need attention (permission or question).
          if (pulse.inner?.active === true) {
            tint ??= accentTint(theme)
            if (!originals.has(node)) originals.set(node, node.backgroundColor)
            if (!node.backgroundColor?.equals?.(tint)) {
              node.backgroundColor = tint
            }
            if (
              pulse.backgroundColor &&
              !pulse.backgroundColor.equals?.(tint)
            ) {
              pulse.backgroundColor = tint
            }
          } else if (originals.has(node)) {
            const original = originals.get(node)!
            originals.delete(node)
            node.backgroundColor = original
            if (pulse.backgroundColor) pulse.backgroundColor = original
          }
          // Tabs never nest, so skip their text and indicator children.
          return
        }
        for (const child of children) scan(child)
      }

      scan(context.renderer.root)

      // Tabs that were closed or replaced while their session was running.
      for (const [tab, original] of originals) {
        const node = tab as any
        if (live.has(tab) && !node.isDestroyed) continue
        if (!node.isDestroyed) node.backgroundColor = original
        originals.delete(tab)
      }
    }

    context.renderer.on(CliRenderEvents.FRAME, apply)
    return () => {
      context.renderer.off(CliRenderEvents.FRAME, apply)
      for (const [tab, original] of originals) {
        if (!(tab as any).isDestroyed) (tab as any).backgroundColor = original
      }
      originals.clear()
    }
  },
})

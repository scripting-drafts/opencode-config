import {
  BoxRenderable,
  CliRenderEvents,
  Renderable,
  type OptimizedBuffer,
  type RenderContext,
  type RGBA,
} from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "local.taller-tabs",
  setup(context) {
    let strip: BoxRenderable | undefined
    const edges = new Map<BoxRenderable, HalfRowPulse>()
    const apply = () => {
      for (const [tab] of edges) {
        if (tab.isDestroyed) edges.delete(tab)
      }
      if (!strip || strip.isDestroyed) strip = findStrip(context.renderer.root, context.renderer.width)
      if (!strip) return
      if (strip.height === 1) strip.height = 2
      for (const tab of strip.getChildren()) {
        if (!(tab instanceof BoxRenderable) || edges.has(tab)) continue
        const pulse = tab.getChildren().find((part) => part.id.startsWith("tab_pulse-"))
        if (!pulse) continue
        const edge = new HalfRowPulse(context.renderer, tab, pulse, () => context.theme.background.base)
        tab.add(edge)
        edges.set(tab, edge)
      }
    }
    context.renderer.on(CliRenderEvents.FRAME, apply)
    return () => {
      context.renderer.off(CliRenderEvents.FRAME, apply)
      for (const edge of edges.values()) {
        if (!edge.isDestroyed) edge.destroy()
      }
      if (strip && !strip.isDestroyed) strip.height = 1
    }
  },
})

class HalfRowPulse extends Renderable {
  constructor(
    context: RenderContext,
    private tab: BoxRenderable,
    private pulse: Renderable,
    private page: () => RGBA,
  ) {
    super(context, {
      id: `local-half-tab-${tab.id}`,
      position: "absolute",
      top: 1,
      left: 0,
      width: "100%",
      height: 1,
      zIndex: 3,
    })
  }

  protected override renderSelf(buffer: OptimizedBuffer, deltaTime: number) {
    const background = this.page()
    // Follow the pulse's background so a tint layer painted above this row
    // matches the half-row too (for example the running-tab blue).
    const base = (this.pulse as any)._backgroundColor ?? this.tab.backgroundColor
    buffer.drawText("▀".repeat(this.width), this.screenX, this.screenY, base, background)

    // Replay the host pulse's paint, not its clock: every half-row cell uses
    // exactly the same running, glow, and completion color as the row above.
    const mirror: OptimizedBuffer["setCell"] = (x, _y, _char, _foreground, color) => {
      buffer.setCell(x, this.screenY, "▀", color, background)
    }
    const canvas = new Proxy(buffer, {
      get(target, key) {
        if (key === "setCell") return mirror
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const paint = Reflect.get(this.pulse, "renderSelf") as (buffer: OptimizedBuffer, deltaTime: number) => void
    paint.call(this.pulse, canvas, deltaTime)
  }
}

// OpenCode 2.2.5 has no tab-height setting or tab-strip slot. Match only the
// horizontal strip's pulse/title structure, leaving vertical tabs untouched.
function findStrip(node: Renderable, width: number): BoxRenderable | undefined {
  if (node.screenY !== 0) return undefined
  if (
    node instanceof BoxRenderable &&
    node.width === width &&
    node.getChildren().some(
      (tab) =>
        tab.getChildren().some((part) => part.id.startsWith("tab_pulse-")) &&
        tab.getChildren().some((row) => row.getChildren().some((label) => label.id.startsWith("title_shimmer-"))),
    )
  ) {
    return node
  }
  for (const child of node.getChildren()) {
    const strip = findStrip(child, width)
    if (strip) return strip
  }
}

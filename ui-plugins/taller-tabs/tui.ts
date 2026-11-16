import {
  BoxRenderable,
  CliRenderEvents,
  Renderable,
  RGBA,
  type OptimizedBuffer,
  type RenderContext,
} from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"

// Tint refresh interval.
const RESCAN_MS = 100
// Share of the Build blue blended over the page.
const TINT_OPACITY = 0.4

type Theme = {
  background: {
    base: RGBA
    action: { primary: { hovered: RGBA } }
  }
  border: { base: RGBA }
  hue: { blue: Record<number, RGBA> }
}

type TabState = {
  overlay: BoxRenderable | undefined
  tint: RGBA | undefined
  pulse: any | undefined
}

const sameColor = (a: RGBA | undefined, b: RGBA | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.equals?.(b) === true)

function fade(color: RGBA, base: RGBA): RGBA {
  const [r, g, b] = color.toInts()
  const [br, bg, bb] = base.toInts()
  const mix = (from: number, to: number) =>
    Math.round(to + (from - to) * TINT_OPACITY)
  const Color = base.constructor as {
    fromInts: (r: number, g: number, b: number) => RGBA
  }
  return Color.fromInts(mix(r!, br!), mix(g!, bg!), mix(b!, bb!))
}

function findPulse(node: any): any {
  return node
    .getChildren?.()
    .find(
      (child: any) =>
        typeof child.id === "string" && child.id.startsWith("tab_pulse-"),
    )
}

function findTitle(node: any): any {
  for (const child of node.getChildren?.() ?? []) {
    if (
      typeof child.id === "string" &&
      child.id.startsWith("title_shimmer-")
    ) {
      return child
    }
    const title = findTitle(child)
    if (title) return title
  }
}

export default Plugin.define({
  id: "local.taller-tabs",
  setup(context) {
    let strip: BoxRenderable | undefined
    const edges = new Map<BoxRenderable, HalfRowPulse>()
    const states = new Map<BoxRenderable, TabState>()
    const hovering = new Map<BoxRenderable, { width: number }>()
    let lastScan = 0

    const release = (tab: BoxRenderable, state: TabState) => {
      if (state.overlay && !state.overlay.isDestroyed) {
        state.overlay.destroy()
      }
      if (
        state.pulse &&
        !state.pulse.isDestroyed &&
        !tab.isDestroyed &&
        state.tint
      ) {
        state.pulse._backgroundColor = tab.backgroundColor
        state.pulse.requestRender?.()
      }
      state.overlay = undefined
      state.tint = undefined
      state.pulse = undefined
    }

    const apply = () => {
      for (const tab of edges.keys()) {
        if (tab.isDestroyed) edges.delete(tab)
      }
      for (const tab of states.keys()) {
        if (tab.isDestroyed) states.delete(tab)
      }
      for (const tab of hovering.keys()) {
        if (tab.isDestroyed) hovering.delete(tab)
      }
      if (!strip || strip.isDestroyed) {
        strip = findStrip(context.renderer.root, context.renderer.width)
      }
      if (!strip) return

      const tabs: Array<{
        tab: BoxRenderable
        pulse: any
        title: any
      }> = []
      for (const child of strip.getChildren()) {
        if (!(child instanceof BoxRenderable)) continue
        const pulse = findPulse(child)
        if (!pulse) continue
        tabs.push({ tab: child, pulse, title: findTitle(child) })
        if (!edges.has(child)) {
          const edge = new HalfRowPulse(
            context.renderer,
            child,
            pulse,
            () => states.get(child)?.tint,
            () => context.theme.background.base,
            () => context.theme.border.base,
          )
          child.add(edge)
          edges.set(child, edge)
        }
      }
      if (tabs.length === 0) return

      const theme = context.theme as unknown as Theme
      const selected = tabs.map(
        ({ tab, title }) =>
          ((title?.attributes ?? 0) & 1) !== 0 &&
          !sameColor(
            tab.backgroundColor,
            theme.background.action.primary.hovered,
          ),
      )

      const count = (context.ui.tabs.list?.() ?? []).length || tabs.length
      const number = Math.max(2, String(count + 1).length)

      // The host gives the selected tab the leftover width. Match it to 90%
      // of the median neighbor and shrink the title to fit the narrower box.
      const current = selected.findIndex(Boolean)
      if (current !== -1 && tabs.length > 1) {
        const widths = tabs
          .filter((_, index) => index !== current)
          .map(({ tab }) => hovering.get(tab)?.width ?? tab.width)
          .filter((width) => Number.isFinite(width) && width > 0)
          .sort((a, b) => a - b)
        if (widths.length > 0) {
          const median = widths[Math.floor(widths.length / 2)]!
          const target = Math.max(1, Math.round(median * 0.9))
          const tab = tabs[current]!.tab
          if (tab.width !== target) tab.width = target
          const title = tabs[current]!.title
          if (title) {
            const width = Math.max(1, target - 1 - number - 2)
            if (title.width !== width) title.width = width
          }
        }
      }

      // A hovered neighbor keeps its normal title width; widen it by the two
      // columns the close button occupies.
      for (let index = 0; index < tabs.length; index++) {
        const { tab, title } = tabs[index]!
        if (selected[index]) {
          hovering.delete(tab)
          continue
        }
        const isHovered = sameColor(
          tab.backgroundColor,
          theme.background.action.primary.hovered,
        )
        const saved = hovering.get(tab)
        if (isHovered) {
          if (!saved) hovering.set(tab, { width: tab.width })
          const base = hovering.get(tab)!.width
          const width = base + 2
          if (tab.width !== width) tab.width = width
          if (title) {
            const titleWidth = Math.max(1, base - 1 - number)
            if (title.width !== titleWidth) title.width = titleWidth
          }
        } else if (saved) {
          if (tab.width !== saved.width) tab.width = saved.width
          if (title) {
            const titleWidth = Math.max(1, saved.width - 1 - number)
            if (title.width !== titleWidth) title.width = titleWidth
          }
          hovering.delete(tab)
        }
      }

      const hovered = tabs.map(({ tab }) =>
        sameColor(
          tab.backgroundColor,
          theme.background.action.primary.hovered,
        ),
      )

      // One extra layout row holds the thin base edge; the hovered tab uses
      // the full row, the others keep an upper-eighth lip.
      if (strip.height !== 2) strip.height = 2
      for (let index = 0; index < tabs.length; index++) {
        const { tab } = tabs[index]!
        const height = hovered[index] ? 2 : 1
        if (tab.height !== height) tab.height = height
        const edge = edges.get(tab)
        if (edge && !edge.visible) edge.visible = true
      }

      const now = Date.now()
      if (now - lastScan < RESCAN_MS) return
      lastScan = now

      let tint: RGBA | undefined
      for (let index = 0; index < tabs.length; index++) {
        const { tab, pulse } = tabs[index]!
        let state = states.get(tab)
        if (!state) {
          state = { overlay: undefined, tint: undefined, pulse: undefined }
          states.set(tab, state)
        }
        if (selected[index]) {
          tint ??= fade(theme.hue.blue[200], theme.background.base)
          state.pulse = pulse

          if (!state.overlay || state.overlay.isDestroyed) {
            state.overlay = new BoxRenderable(context.renderer, {
              id: `local-tab-tint-${pulse.id}`,
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              zIndex: 0,
              backgroundColor: tint,
            })
            tab.add(state.overlay, 0)
          } else if (!sameColor(state.overlay.backgroundColor, tint)) {
            state.overlay.backgroundColor = tint
          }

          if (!sameColor(state.tint, tint)) {
            state.tint = tint
            pulse._backgroundColor = tint
            pulse.requestRender?.()
          }
        } else {
          release(tab, state)
          states.delete(tab)
        }
      }
    }

    context.renderer.on(CliRenderEvents.FRAME, apply)
    const kick = setTimeout(() => {
      lastScan = 0
      apply()
      context.renderer.requestRender()
    }, 0)
    return () => {
      clearTimeout(kick)
      context.renderer.off(CliRenderEvents.FRAME, apply)
      for (const edge of edges.values()) {
        if (!edge.isDestroyed) edge.destroy()
      }
      for (const [tab, state] of states) {
        release(tab, state)
      }
      for (const [tab, saved] of hovering) {
        if (!tab.isDestroyed) tab.width = saved.width
      }
      edges.clear()
      states.clear()
      hovering.clear()
      if (strip && !strip.isDestroyed) strip.height = 1
    }
  },
})

class HalfRowPulse extends Renderable {
  constructor(
    context: RenderContext,
    private tab: BoxRenderable,
    private pulse: Renderable,
    private tint: () => RGBA | undefined,
    private page: () => RGBA,
    private border: () => RGBA,
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
    const full = this.tab.height >= 2
    const tint = this.tint()
    const base =
      tint ??
      (full
        ? ((this.pulse as any)._backgroundColor ?? this.tab.backgroundColor)
        : this.border())
    const background = full && tint ? tint : this.page()
    if (tint || full) {
      if (!base.equals?.((this.pulse as any)._backgroundColor)) {
        ;(this.pulse as any)._backgroundColor = base
      }
    }
    buffer.drawText(
      (full ? "▀" : "▔").repeat(this.width),
      this.screenX,
      this.screenY,
      base,
      background,
    )
    if (!full) return

    // Replay the host pulse's paint, not its clock: every half-row cell uses
    // exactly the same running, glow, and completion color as the row above.
    const mirror: OptimizedBuffer["setCell"] = (
      x,
      _y,
      _char,
      _foreground,
      color,
    ) => {
      buffer.setCell(x, this.screenY, "▀", color, background)
    }
    const canvas = new Proxy(buffer, {
      get(target, key) {
        if (key === "setCell") return mirror
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const paint = Reflect.get(this.pulse, "renderSelf") as (
      buffer: OptimizedBuffer,
      deltaTime: number,
    ) => void
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
        tab
          .getChildren()
          .some((row) =>
            row
              .getChildren()
              .some((label) => label.id.startsWith("title_shimmer-")),
          ),
    )
  ) {
    return node
  }
  for (const child of node.getChildren()) {
    const strip = findStrip(child, width)
    if (strip) return strip
  }
}

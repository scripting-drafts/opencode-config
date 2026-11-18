import {
  BoxRenderable,
  CliRenderEvents,
  Renderable,
  type OptimizedBuffer,
  type RenderContext,
  type RGBA,
} from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"

// The host renders one-row horizontal tabs. This plugin gives the strip a
// second row and keeps long tab names static and readable while hovered.
type MouseHandler = (event: any) => void

type TabHoverPatch = {
  previousOver?: MouseHandler
  previousOut?: MouseHandler
  over: MouseHandler
  out: MouseHandler
}

export default Plugin.define({
  id: "local.taller-tabs",
  setup(context) {
    let strip: BoxRenderable | undefined
    const edges = new Map<BoxRenderable, HalfRowPulse>()
    const hoveredTabs = new Set<BoxRenderable>()
    const tabHoverPatches = new Map<BoxRenderable, TabHoverPatch>()
    const titleOverlays = new Map<BoxRenderable, StaticTitle>()
    let applyFailures = 0

    const destroyTitleOverlay = (tab: BoxRenderable) => {
      const overlay = titleOverlays.get(tab)
      if (overlay && !overlay.isDestroyed) overlay.destroy()
      titleOverlays.delete(tab)
    }

    const updateTitleOverlay = (tab: BoxRenderable, source: any) => {
      if (!source || source.isDestroyed) {
        destroyTitleOverlay(tab)
        return
      }
      const width = Math.max(1, Math.floor(Number(source.width) || 0))
      const height = Math.max(1, Math.floor(Number(source.height) || 0))
      const left = (Number(source.screenX) || 0) - (Number(tab.screenX) || 0)
      const top = (Number(source.screenY) || 0) - (Number(tab.screenY) || 0)
      let overlay = titleOverlays.get(tab)
      if (!overlay || overlay.isDestroyed) {
        overlay = new StaticTitle(
          context.renderer,
          tab,
          source,
          () => context.theme.background.base,
          () => context.theme.text.base,
          left,
          top,
          width,
          height,
        )
        tab.add(overlay)
        titleOverlays.set(tab, overlay)
      } else {
        overlay.source = source
        overlay.left = left
        overlay.top = top
        overlay.width = width
        overlay.height = height
      }
      overlay.visible = hoveredTabs.has(tab)
    }

    const restoreTabHover = (tab: BoxRenderable) => {
      const patch = tabHoverPatches.get(tab)
      if (patch && !tab.isDestroyed) {
        const host = tab as any
        if (host._mouseListeners?.over === patch.over) tab.onMouseOver = patch.previousOver
        if (host._mouseListeners?.out === patch.out) tab.onMouseOut = patch.previousOut
      }
      tabHoverPatches.delete(tab)
      hoveredTabs.delete(tab)
      const overlay = titleOverlays.get(tab)
      if (overlay) overlay.visible = false
    }

    const restoreTabPatches = () => {
      for (const tab of [...tabHoverPatches.keys()]) restoreTabHover(tab)
      for (const tab of [...titleOverlays.keys()]) {
        destroyTitleOverlay(tab)
        hoveredTabs.delete(tab)
      }
      hoveredTabs.clear()
    }

    const patchTabHover = (tab: BoxRenderable) => {
      const host = tab as any
      const existing = tabHoverPatches.get(tab)
      if (
        existing &&
        host._mouseListeners?.over === existing.over &&
        host._mouseListeners?.out === existing.out
      ) {
        return
      }
      if (existing) restoreTabHover(tab)
      const previousOver = host._mouseListeners?.over
      const previousOut = host._mouseListeners?.out
      const over = (event: any) => {
        hoveredTabs.add(tab)
        const overlay = titleOverlays.get(tab)
        if (overlay) overlay.visible = true
        previousOver?.call(tab, event)
      }
      const out = (event: any) => {
        previousOut?.call(tab, event)
        hoveredTabs.delete(tab)
        const overlay = titleOverlays.get(tab)
        if (overlay) overlay.visible = false
      }
      tab.onMouseOver = over
      tab.onMouseOut = out
      tabHoverPatches.set(tab, { previousOver, previousOut, over, out })
    }

    const apply = () => {
      try {
        for (const [tab] of edges) {
          if (tab.isDestroyed) edges.delete(tab)
        }
        for (const [tab] of tabHoverPatches) {
          if (tab.isDestroyed) {
            hoveredTabs.delete(tab)
            tabHoverPatches.delete(tab)
          }
        }
        for (const [tab, overlay] of titleOverlays) {
          if (tab.isDestroyed || overlay.isDestroyed) titleOverlays.delete(tab)
        }
        if (strip && (strip.isDestroyed || strip.width !== context.renderer.width || strip.screenY !== 0)) {
          restoreTabPatches()
          for (const edge of edges.values()) {
            if (!edge.isDestroyed) edge.destroy()
          }
          edges.clear()
          if (!strip.isDestroyed) strip.height = 1
          strip = undefined
        }
        if (!strip) strip = findStrip(context.renderer.root, context.renderer.width)
        if (!strip) return
        if (strip.height === 1) strip.height = 2
        for (const child of strip.getChildren()) {
          if (!(child instanceof BoxRenderable) || !hasPulse(child)) continue
          const pulse = child.getChildren().find(
            (part) => typeof part.id === "string" && part.id.startsWith("tab_pulse-"),
          )
          if (!pulse) continue
          const edge = edges.get(child)
          if (edge && (edge.isDestroyed || edge.pulse !== pulse)) {
            if (!edge.isDestroyed) edge.destroy()
            edges.delete(child)
          }
          if (!edges.has(child)) {
            const nextEdge = new HalfRowPulse(
              context.renderer,
              child,
              pulse,
              () => context.theme.background.base,
            )
            child.add(nextEdge)
            edges.set(child, nextEdge)
          }
          patchTabHover(child)
          updateTitleOverlay(child, findTitle(child))
        }
        applyFailures = 0
      } catch {
        applyFailures++
        if (applyFailures < 3) return
        context.renderer.off(CliRenderEvents.FRAME, apply)
        restoreTabPatches()
        for (const edge of edges.values()) {
          if (!edge.isDestroyed) edge.destroy()
        }
        edges.clear()
        if (strip && !strip.isDestroyed) strip.height = 1
        strip = undefined
      }
    }

    context.renderer.on(CliRenderEvents.FRAME, apply)
    const kick = setTimeout(() => {
      apply()
      if (!context.renderer.isDestroyed) context.renderer.requestRender()
    }, 0)
    return () => {
      clearTimeout(kick)
      context.renderer.off(CliRenderEvents.FRAME, apply)
      restoreTabPatches()
      for (const edge of edges.values()) {
        if (!edge.isDestroyed) edge.destroy()
      }
      edges.clear()
      if (strip && !strip.isDestroyed) strip.height = 1
      strip = undefined
    }
  },
})

const FORMAT_CONTROL =
  /[\p{Cc}\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u

function displayText(value: string): string {
  let result = ""
  for (const character of value) {
    if (!FORMAT_CONTROL.test(character)) result += character
  }
  return result.replace(/\s+/g, " ").trim()
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new (Intl as any).Segmenter(undefined, { granularity: "grapheme" })
    : undefined

function clip(text: string, max: number) {
  if (max <= 0) return ""
  if (Bun.stringWidth(text) <= max) return text
  const parts = graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), (part: any) => part.segment as string)
    : Array.from(text)
  let result = ""
  let width = 0
  for (const part of parts) {
    const next = Bun.stringWidth(part)
    if (width + next > max) break
    result += part
    width += next
  }
  return result
}

function fitTitle(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text
  return width > 1 ? `${clip(text, width - 1)}…` : clip(text, width)
}

function hasPulse(node: Renderable): boolean {
  return node.getChildren().some((part) => typeof part.id === "string" && part.id.startsWith("tab_pulse-"))
}

function findTitle(node: any): any {
  for (const child of node.getChildren?.() ?? []) {
    if (typeof child.id === "string" && child.id.startsWith("title_shimmer-")) return child
    const title = findTitle(child)
    if (title) return title
  }
}

class StaticTitle extends Renderable {
  constructor(
    context: RenderContext,
    private tab: BoxRenderable,
    public source: any,
    private pageBackground: () => RGBA,
    private pageForeground: () => RGBA,
    left: number,
    top: number,
    width: number,
    height: number,
  ) {
    super(context, {
      id: `local-static-title-${tab.id}`,
      position: "absolute",
      left,
      top,
      width,
      height,
      zIndex: 2,
      visible: false,
    })
  }

  protected override renderSelf(buffer: OptimizedBuffer, _deltaTime: number) {
    if (this.source?.isDestroyed) return
    const width = Math.max(0, Math.floor(this.width))
    const height = Math.max(0, Math.floor(this.height))
    if (width <= 0 || height <= 0) return
    const background = this.tab.backgroundColor ?? this.pageBackground()
    buffer.fillRect(this.screenX, this.screenY, width, height, background)
    const foreground = this.source.fg ?? this.source.color ?? this.pageForeground()
    const attributes = typeof this.source.attributes === "number" ? this.source.attributes : undefined
    const title = displayText(String(this.source?._rename?.title ?? ""))
    // Cover the host's marquee completely, including its leftover glyphs.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        buffer.setCell(this.screenX + x, this.screenY + y, " ", foreground, background)
      }
    }
    buffer.drawText(fitTitle(title, width), this.screenX, this.screenY, foreground, background, attributes)
  }
}

class HalfRowPulse extends Renderable {
  constructor(
    context: RenderContext,
    private tab: BoxRenderable,
    readonly pulse: Renderable,
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
    buffer.drawText("▀".repeat(this.width), this.screenX, this.screenY, this.tab.backgroundColor, background)
    if (this.pulse.isDestroyed) return

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
    const paint = Reflect.get(this.pulse, "renderSelf")
    if (typeof paint !== "function") return
    try {
      paint.call(this.pulse, canvas, deltaTime)
    } catch {
      // Keep the base half-row rather than break the host's frame loop.
    }
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
        tab.getChildren().some(
          (part) => typeof part.id === "string" && part.id.startsWith("tab_pulse-"),
        ) &&
        tab.getChildren().some((row) =>
          row.getChildren().some(
            (label) => typeof label.id === "string" && label.id.startsWith("title_shimmer-"),
          ),
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

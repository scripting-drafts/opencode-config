import {
  BoxRenderable,
  CliRenderEvents,
  Renderable,
  type OptimizedBuffer,
  type RenderContext,
  type RGBA,
} from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"

// The host truncates tab titles to fit the strip. Clicking a tab reveals its
// full title, plus the session's working directory, in a short-lived banner.
const BANNER_MS = 4000

type TabHit = {
  key: string
  x: number
  y: number
  width: number
  height: number
  title: string
  sessionID?: string
}

export default Plugin.define({
  id: "local.taller-tabs",
  setup(context) {
    let strip: BoxRenderable | undefined
    const edges = new Map<BoxRenderable, HalfRowPulse>()
    let hits: TabHit[] = []
    let banner: Banner | undefined
    let bannerTimer: ReturnType<typeof setTimeout> | undefined
    let down: { key: string; x: number; y: number } | undefined
    let wrapped: BoxRenderable | undefined
    let previousDown: ((event: any) => void) | undefined
    let previousUp: ((event: any) => void) | undefined
    let downHandler: ((event: any) => void) | undefined
    let upHandler: ((event: any) => void) | undefined

    const hitAt = (x: number, y: number) =>
      hits.find((hit) => x >= hit.x && x < hit.x + hit.width && y >= hit.y && y < hit.y + hit.height)

    const clearBanner = () => {
      if (bannerTimer) {
        clearTimeout(bannerTimer)
        bannerTimer = undefined
      }
      if (banner && !banner.isDestroyed) banner.destroy()
      banner = undefined
      if (!context.renderer.isDestroyed) context.renderer.requestRender()
    }

    const showBanner = (hit: TabHit) => {
      const title = hit.title.replace(/\s+/g, " ").trim()
      if (!title) return
      clearBanner()
      const session = hit.sessionID ? (context.data.session.get(hit.sessionID) as any) : undefined
      const directory = session?.location?.directory
      const theme = context.theme as any
      const width = Math.max(
        8,
        Math.min(
          context.renderer.width - 2,
          Math.max(Bun.stringWidth(title), directory ? Bun.stringWidth(directory) : 0) + 4,
        ),
      )
      const height = directory ? 2 : 1
      const left = Math.max(0, Math.min(hit.x, context.renderer.width - width))
      const top = Math.max(2, Math.min(context.renderer.height - height, hit.y + hit.height))
      try {
        banner = new Banner(
          context.renderer,
          title,
          directory,
          theme.text.base,
          theme.text.muted,
          theme.background.raised?.high ?? theme.background.raised?.base ?? theme.background.base,
          theme.hue?.blue?.[200] ?? theme.text.base,
          width,
          height,
          left,
          top,
        )
        context.renderer.root.add(banner)
        context.renderer.requestRender()
        bannerTimer = setTimeout(clearBanner, BANNER_MS)
      } catch {
        context.ui.toast.show({ title, message: directory ?? "", duration: BANNER_MS })
      }
    }

    const restoreHandlers = () => {
      if (wrapped && !wrapped.isDestroyed) {
        if ((wrapped as any)._mouseListeners?.down === downHandler) wrapped.onMouseDown = previousDown
        if ((wrapped as any)._mouseListeners?.up === upHandler) wrapped.onMouseUp = previousUp
      }
      wrapped = undefined
      previousDown = undefined
      previousUp = undefined
      downHandler = undefined
      upHandler = undefined
      down = undefined
    }

    // Wrap the strip's own mouse handlers so a click can reveal the full name
    // without taking over selection, dragging, or the close button.
    const attachHandlers = () => {
      if (!strip || strip.isDestroyed) return
      if (wrapped === strip && (strip as any)._mouseListeners?.up === upHandler) return
      restoreHandlers()
      const target = strip
      wrapped = target
      const host = target as any
      const previousDownHandler = host._mouseListeners?.down
      const previousUpHandler = host._mouseListeners?.up
      previousDown = previousDownHandler
      previousUp = previousUpHandler
      downHandler = (event: any) => {
        previousDownHandler?.call(target, event)
        if (event.propagationStopped || event.button !== 0) return
        const hit = hitAt(event.x, event.y)
        down = hit ? { key: hit.key, x: event.x, y: event.y } : undefined
      }
      upHandler = (event: any) => {
        previousUpHandler?.call(target, event)
        if (event.propagationStopped || event.button !== 0) return
        const start = down
        down = undefined
        if (!start) return
        if (Math.abs(event.x - start.x) > 1 || Math.abs(event.y - start.y) > 1) return
        const hit = hitAt(event.x, event.y)
        if (hit?.key === start.key) showBanner(hit)
      }
      target.onMouseDown = downHandler
      target.onMouseUp = upHandler
    }

    const apply = () => {
      for (const [tab] of edges) {
        if (tab.isDestroyed) edges.delete(tab)
      }
      if (!strip || strip.isDestroyed) strip = findStrip(context.renderer.root, context.renderer.width)
      if (!strip) return
      if (strip.height === 1) strip.height = 2
      const sessions = context.ui.tabs.list?.() ?? []
      hits = []
      for (const tab of strip.getChildren()) {
        if (!(tab instanceof BoxRenderable)) continue
        const pulse = tab.getChildren().find((part) => part.id.startsWith("tab_pulse-"))
        if (!pulse) continue
        if (!edges.has(tab)) {
          const edge = new HalfRowPulse(context.renderer, tab, pulse, () => context.theme.background.base)
          tab.add(edge)
          edges.set(tab, edge)
        }
        const titleNode = findTitle(tab)
        const title = titleNode?._rename?.title ?? titleNode?.plainText ?? ""
        const sessionID = sessions.find((session) => session.title === title)?.sessionID
        hits.push({
          key: sessionID ?? `${title}\n${tab.screenX}`,
          x: tab.screenX,
          y: tab.screenY,
          width: tab.width,
          height: tab.height,
          title,
          sessionID,
        })
      }
      attachHandlers()
    }

    context.renderer.on(CliRenderEvents.FRAME, apply)
    const kick = setTimeout(() => {
      apply()
      if (!context.renderer.isDestroyed) context.renderer.requestRender()
    }, 0)
    return () => {
      clearTimeout(kick)
      context.renderer.off(CliRenderEvents.FRAME, apply)
      clearBanner()
      restoreHandlers()
      for (const edge of edges.values()) {
        if (!edge.isDestroyed) edge.destroy()
      }
      if (strip && !strip.isDestroyed) strip.height = 1
    }
  },
})

function findTitle(node: any): any {
  for (const child of node.getChildren?.() ?? []) {
    if (typeof child.id === "string" && child.id.startsWith("title_shimmer-")) return child
    const title = findTitle(child)
    if (title) return title
  }
}

function clip(text: string, max: number) {
  if (max <= 0) return ""
  if (Bun.stringWidth(text) <= max) return text
  let result = ""
  let width = 0
  for (const character of text) {
    const next = Bun.stringWidth(character)
    if (width + next > max) break
    result += character
    width += next
  }
  return result
}

class Banner extends Renderable {
  constructor(
    context: RenderContext,
    private title: string,
    private directory: string | undefined,
    private fg: RGBA,
    private muted: RGBA,
    private background: RGBA,
    private accent: RGBA,
    width: number,
    height: number,
    left: number,
    top: number,
  ) {
    super(context, {
      id: `local-tab-name-${Date.now()}`,
      position: "absolute",
      left,
      top,
      width,
      height,
      zIndex: 20,
    })
  }

  protected override renderSelf(buffer: OptimizedBuffer, _deltaTime: number) {
    buffer.fillRect(this.screenX, this.screenY, this.width, this.height, this.background)
    buffer.fillRect(this.screenX, this.screenY, 1, this.height, this.accent)
    buffer.drawText(clip(this.title, this.width - 3), this.screenX + 2, this.screenY, this.fg, this.background)
    if (this.directory) {
      buffer.drawText(
        clip(this.directory, this.width - 3),
        this.screenX + 2,
        this.screenY + 1,
        this.muted,
        this.background,
      )
    }
  }
}

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
    buffer.drawText("▀".repeat(this.width), this.screenX, this.screenY, this.tab.backgroundColor, background)

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

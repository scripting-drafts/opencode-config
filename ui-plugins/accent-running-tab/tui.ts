import { CliRenderEvents, type RGBA } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"

// Share of the OpenCode blue blended into tab backgrounds.
const ACTIVE_TINT = 0.55
const RUNNING_TINT = 0.35
const ACTIVE_RUNNING_TINT = 0.68
// Rescan the renderable tree at most this often.
const RESCAN_MS = 100

// `hue.blue[200]` from the built-in OpenCode palette, per mode.
const OPENCODE_BLUE = {
  light: [0x3b, 0x7d, 0xd8],
  dark: [0x5c, 0x9c, 0xf5],
} as const

type Theme = {
  background: {
    base: RGBA
    raised: { base: RGBA; high: RGBA }
  }
}

type TabState = {
  // Host-owned background to restore when the tab is no longer tinted.
  original: RGBA | undefined
  // Last tint we painted, used to detect host background changes.
  applied: RGBA | undefined
}

const sameColor = (a: RGBA | undefined, b: RGBA | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.equals?.(b) === true)

function blueTint(theme: Theme, amount: number): RGBA {
  const base = theme.background.base.toInts()
  const luma = (base[0]! * 299 + base[1]! * 587 + base[2]! * 114) / 1000
  const blue = luma > 128 ? OPENCODE_BLUE.light : OPENCODE_BLUE.dark
  const mix = (index: number) =>
    Math.round(base[index]! + (blue[index]! - base[index]!) * amount)
  const Color = theme.background.base.constructor as {
    fromInts: (r: number, g: number, b: number) => RGBA
  }
  return Color.fromInts(mix(0), mix(1), mix(2))
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
  id: "local.accent-running-tab",
  setup(context) {
    const states = new Map<object, TabState>()
    let lastScan = 0
    let paint: ReturnType<typeof setTimeout> | undefined
    let rescan: ReturnType<typeof setTimeout> | undefined

    const apply = () => {
      const now = Date.now()
      if (now - lastScan < RESCAN_MS) return
      lastScan = now

      const theme = context.theme as unknown as Theme
      const live = new Set<object>()
      let changed = false
      let followUp = false

      const scan = (node: any) => {
        if (node.isDestroyed) return
        const children = node.getChildren?.() ?? []
        const pulse = children.find(
          (child: any) =>
            typeof child.id === "string" && child.id.startsWith("tab_pulse-"),
        )
        if (pulse) {
          live.add(node)

          // A selected tab is bold, while the host paints it with raised.high.
          // A merely hovered tab is also bold but uses raised.base instead.
          const title = findTitle(node)
          const selected =
            ((title?.attributes ?? 0) & 1) !== 0 &&
            (!sameColor(node.backgroundColor, theme.background.raised.base) ||
              sameColor(
                states.get(node)?.original,
                theme.background.raised.high,
              ))

          // The host sets `active` for a session that is running and does not
          // need attention (permission or question).
          const running = pulse.inner?.active === true
          const current = node.backgroundColor
          let state = states.get(node)

          // The host owns the background while it is not our tint, so remember
          // its latest value before painting over it.
          if (!state || !sameColor(current, state.applied)) {
            state = { original: current, applied: undefined }
            states.set(node, state)
          }

          if (selected || running) {
            const amount =
              selected && running
                ? ACTIVE_RUNNING_TINT
                : selected
                  ? ACTIVE_TINT
                  : RUNNING_TINT
            const tint = blueTint(theme, amount)
            state.applied = tint
            if (!sameColor(current, tint)) {
              node.backgroundColor = tint
              changed = true
              followUp = true
            }
            if (
              pulse.backgroundColor &&
              !sameColor(pulse.backgroundColor, tint)
            ) {
              pulse.backgroundColor = tint
              changed = true
              followUp = true
            }
          } else {
            if (state.applied) {
              if (!sameColor(current, state.original)) {
                node.backgroundColor = state.original
                changed = true
                followUp = true
              }
              if (
                pulse.backgroundColor &&
                sameColor(pulse.backgroundColor, state.applied)
              ) {
                pulse.backgroundColor = state.original
                changed = true
                followUp = true
              }
            }
            states.delete(node)
          }
          // Tabs never nest, so skip their text and indicator children.
          return
        }
        for (const child of children) scan(child)
      }

      scan(context.renderer.root)

      // Tabs that were closed or replaced while tinted.
      for (const [tab, state] of states) {
        const node = tab as any
        if (live.has(tab) && !node.isDestroyed) continue
        if (!node.isDestroyed && state.applied) {
          node.backgroundColor = state.original
          changed = true
          followUp = true
        }
        states.delete(tab)
      }

      if (changed && !paint) {
        paint = setTimeout(() => {
          paint = undefined
          context.renderer.requestRender()
        }, 0)
      }
      // The host may overwrite the tint while its selection animation settles.
      // Rescan once more after that animation to put the tint back on top.
      if (followUp && !rescan) {
        rescan = setTimeout(() => {
          rescan = undefined
          lastScan = 0
          apply()
        }, RESCAN_MS)
      }
    }

    context.renderer.on(CliRenderEvents.FRAME, apply)
    // The host may already be idle on first paint; ask for one more frame so
    // the selected tab is tinted immediately.
    const kick = setTimeout(() => {
      lastScan = 0
      apply()
      context.renderer.requestRender()
    }, 0)
    return () => {
      clearTimeout(kick)
      if (paint) clearTimeout(paint)
      if (rescan) clearTimeout(rescan)
      context.renderer.off(CliRenderEvents.FRAME, apply)
      for (const [tab, state] of states) {
        const node = tab as any
        if (!node.isDestroyed && state.applied) {
          node.backgroundColor = state.original
        }
      }
      states.clear()
    }
  },
})

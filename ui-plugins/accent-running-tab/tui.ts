import { BoxRenderable, CliRenderEvents, type RGBA } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"

// Share of the OpenCode blue blended into tab backgrounds.
const ACTIVE_TINT = 0.55
const RUNNING_TINT = 0.35
const ACTIVE_RUNNING_TINT = 0.68
// Rescan the renderable tree at most this often.
const RESCAN_MS = 100

// `hue.blue[300]` in light and `hue.blue[100]` in dark from the built-in
// OpenCode palette: one step lighter than the default 200.
const OPENCODE_BLUE = {
  light: [0x51, 0x8e, 0xe4],
  dark: [0x82, 0xb4, 0xfb],
} as const

type Theme = {
  background: {
    base: RGBA
    raised: { base: RGBA; high: RGBA }
    action: { primary: { hovered: RGBA } }
  }
}

type TabState = {
  overlay: BoxRenderable | undefined
  tint: RGBA | undefined
  pulse: any | undefined
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

    // Hand the tab back to the host: remove the tint layer and let the pulse
    // use the host background again.
    const release = (tab: any, state: TabState) => {
      delete tab.__localTabTint
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
    }

    const apply = () => {
      const now = Date.now()
      if (now - lastScan < RESCAN_MS) return
      lastScan = now

      const theme = context.theme as unknown as Theme
      const live = new Set<object>()

      const scan = (node: any) => {
        if (node.isDestroyed) return
        const children = node.getChildren?.() ?? []
        const pulse = children.find(
          (child: any) =>
            typeof child.id === "string" && child.id.startsWith("tab_pulse-"),
        )
        if (pulse) {
          live.add(node)

          // A selected tab is bold; a merely hovered tab is bold too but the
          // host paints it with the action hover background.
          const title = findTitle(node)
          const selected =
            ((title?.attributes ?? 0) & 1) !== 0 &&
            !sameColor(
              node.backgroundColor,
              theme.background.action.primary.hovered,
            )

          // The host sets `active` for a session that is running and does not
          // need attention (permission or question).
          const running = pulse.inner?.active === true
          let state = states.get(node)
          if (!state) {
            state = { overlay: undefined, tint: undefined, pulse: undefined }
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
            // Stable hand-off for taller-tabs; the host may rewrite the
            // pulse background during its selection animation.
            ;(node as any).__localTabTint = tint

            // Paint on a child overlay instead of the host background so the
            // host's selection animation cannot flash the tab back to its own
            // color. Text and pulse already sit above zIndex 0.
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
              node.add(state.overlay, 0)
            } else if (!sameColor(state.overlay.backgroundColor, tint)) {
              state.overlay.backgroundColor = tint
            }

            // Keep the running pulse's edge on the same background.
            state.pulse = pulse
            if (!sameColor(state.tint, tint)) {
              state.tint = tint
              pulse._backgroundColor = tint
              pulse.requestRender?.()
            }
          } else {
            release(node, state)
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
        release(node, state)
        states.delete(tab)
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
      context.renderer.off(CliRenderEvents.FRAME, apply)
      for (const [tab, state] of states) {
        release(tab as any, state)
      }
      states.clear()
    }
  },
})

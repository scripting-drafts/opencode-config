import { BoxRenderable, CliRenderEvents, RGBA } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"

// Share of the prompt border color blended over the page.
const TINT_OPACITY = 0.4
// Rescan the renderable tree at most this often.
const RESCAN_MS = 100
// Heavy vertical line used for the prompt box's left border.
const PROMPT_BORDER = 0x2503

type Theme = {
  background: {
    base: RGBA
    action: { primary: { hovered: RGBA } }
  }
  border: { base: RGBA }
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
    // Last color read from the prompt box's left border.
    let promptLine: RGBA | undefined

    const promptBorder = (theme: Theme): RGBA => {
      try {
        const buffer = context.renderer.currentRenderBuffer as any
        const found = buffer.withBuffers((cells: any) => {
          let bestX = Infinity
          let best: RGBA | undefined
          for (let y = Math.max(0, cells.height - 10); y < cells.height; y++) {
            for (let x = 0; x < bestX && x < cells.width; x++) {
              const index = y * cells.width + x
              if (cells.char[index] !== PROMPT_BORDER) continue
              bestX = x
              best = RGBA.fromArray(cells.fg.slice(index * 4, index * 4 + 4))
            }
          }
          return best
        })
        if (found) promptLine = found
      } catch {}
      return promptLine ?? theme.border.base
    }

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
            const tint = fade(promptBorder(theme), theme.background.base)
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

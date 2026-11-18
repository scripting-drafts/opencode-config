import { BoxRenderable, Renderable, RGBA, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mock, test, expect } from "bun:test"

mock.module("@opencode/plugin/tui", () => ({
  Plugin: { define: (plugin: any) => plugin },
}))

const plugin = (await import("../ui-plugins/taller-tabs/tui.ts")).default

type VisibleTab = {
  title: string
  onHover?: (label: TextRenderable) => void
}

async function harness(options: { visible: VisibleTab[] }) {
  const width = 80
  const height = 12
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width,
    height,
    screenMode: "main-screen",
  })

  const strip = new BoxRenderable(renderer, {
    id: "strip",
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height: 1,
    flexDirection: "row",
  })
  renderer.root.add(strip)

  const toasts: any[] = []
  let tabOverCalls = 0
  let tabOutCalls = 0
  let stripDownCalls = 0
  let stripUpCalls = 0
  const tabs: BoxRenderable[] = []
  const labels: TextRenderable[] = []

  for (const [index, entry] of options.visible.entries()) {
    const tab = new BoxRenderable(renderer, {
      id: `tab-${index}`,
      width: 20,
      height: 2,
      flexDirection: "column",
    })
    const row = new BoxRenderable(renderer, { id: `row-${index}`, width: 20, height: 1, flexDirection: "row" })
    const label = new TextRenderable(renderer, {
      id: `title_shimmer-${index}`,
      content: entry.title.slice(0, 8),
      width: 10,
    })
    ;(label as any)._rename = { pending: false, title: entry.title }
    row.add(label)
    const pulse = new Renderable(renderer, { id: `tab_pulse-${index}`, width: 20, height: 1 })
    tab.add(row)
    tab.add(pulse)
    tab.onMouseOver = () => {
      tabOverCalls++
      entry.onHover?.(label)
    }
    tab.onMouseOut = () => {
      tabOutCalls++
    }
    strip.add(tab)
    tabs.push(tab)
    labels.push(label)
  }

  strip.onMouseDown = () => {
    stripDownCalls++
  }
  strip.onMouseUp = () => {
    stripUpCalls++
  }

  const originalStripDown = (strip as any)._mouseListeners?.down
  const originalStripUp = (strip as any)._mouseListeners?.up
  const originalTabOver = (tabs[0] as any)._mouseListeners?.over
  const originalTabOut = (tabs[0] as any)._mouseListeners?.out

  const context: any = {
    renderer,
    theme: {
      text: { base: RGBA.fromInts(255, 255, 255, 255), muted: RGBA.fromInts(180, 180, 180, 255) },
      background: {
        base: RGBA.fromInts(0, 0, 0, 255),
        raised: { high: RGBA.fromInts(30, 30, 30, 255), base: RGBA.fromInts(20, 20, 20, 255) },
      },
      hue: { blue: { 200: RGBA.fromInts(80, 140, 220, 255) } },
    },
    ui: {
      toast: { show: (value: any) => toasts.push(value) },
    },
  }

  const cleanup = plugin.setup(context)
  renderer.requestRender()
  await renderOnce()

  const render = async () => {
    renderer.requestRender()
    await renderOnce()
  }

  const hover = async (index: number) => {
    const over = (tabs[index] as any)._mouseListeners?.over
    if (!over) throw new Error("tab hover handler is not attached")
    over({
      button: 0,
      x: tabs[index].screenX + Math.floor(tabs[index].width / 2),
      y: 0,
      propagationStopped: false,
    })
    await render()
  }

  const click = async (index: number) => {
    const down = (strip as any)._mouseListeners?.down
    const up = (strip as any)._mouseListeners?.up
    if (!down || !up) throw new Error("host click handlers are not attached")
    const event = {
      button: 0,
      x: tabs[index].screenX + Math.floor(tabs[index].width / 2),
      y: 0,
      propagationStopped: false,
    }
    down(event)
    up(event)
    await render()
  }

  let disposed = false
  return {
    renderer,
    strip,
    tabs,
    labels,
    render,
    hover,
    click,
    toasts,
    tabOverCalls: () => tabOverCalls,
    tabOutCalls: () => tabOutCalls,
    stripDownCalls: () => stripDownCalls,
    stripUpCalls: () => stripUpCalls,
    originalStripDown,
    originalStripUp,
    originalTabOver,
    originalTabOut,
    capture: () => captureCharFrame(),
    cleanup: async () => {
      if (disposed) return
      disposed = true
      await cleanup()
    },
    destroy: () => renderer.destroy(),
  }
}

async function teardown(current: Awaited<ReturnType<typeof harness>>) {
  try {
    await current.cleanup()
  } finally {
    current.destroy()
  }
}

test("adds a second row and half-row overlays without touching host clicks", async () => {
  const current = await harness({
    visible: [{ title: "Alpha session" }],
  })
  try {
    await current.render()
    expect(current.strip.height).toBe(2)
    const halfRow = current.strip
      .getChildren()
      .some((child) => child.getChildren().some((part) => part.id.startsWith("local-half-tab-")))
    expect(halfRow).toBe(true)
    await current.click(0)
    expect(current.stripDownCalls()).toBe(1)
    expect(current.stripUpCalls()).toBe(1)
    expect((current.strip as any)._mouseListeners?.down).toBe(current.originalStripDown)
    expect((current.strip as any)._mouseListeners?.up).toBe(current.originalStripUp)
    expect(current.toasts.length).toBe(0)
  } finally {
    await teardown(current)
  }
})

test("hovering a truncated title keeps it static instead of repeating it", async () => {
  const current = await harness({
    visible: [
      {
        title: "Long session title",
        onHover: (label) => {
          label.content = "sess… · Long s"
        },
      },
    ],
  })
  try {
    await current.hover(0)
    const frame = current.capture()
    expect(frame).toContain("Long ses")
    expect(frame).not.toContain("·")
    expect(current.tabOverCalls()).toBe(1)
  } finally {
    await teardown(current)
  }
})

test("cleanup restores tab hover handlers, height, and removes overlays", async () => {
  const current = await harness({
    visible: [{ title: "Alpha session" }],
  })
  try {
    await current.hover(0)
    await current.cleanup()
    expect((current.tabs[0] as any)._mouseListeners?.over).toBe(current.originalTabOver)
    expect((current.tabs[0] as any)._mouseListeners?.out).toBe(current.originalTabOut)
    await current.render()
    expect(current.strip.height).toBe(1)
    const overlay = current.strip
      .getChildren()
      .some((child) =>
        child.getChildren().some(
          (part) =>
            part.id.startsWith("local-half-tab-") || part.id.startsWith("local-static-title-"),
        ),
      )
    expect(overlay).toBe(false)
  } finally {
    current.destroy()
  }
})

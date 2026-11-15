import {
  CliRenderEvents,
  Renderable,
  type OptimizedBuffer,
  type RenderContext,
  type RGBA,
} from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG = join(homedir(), ".local", "share", "opencode", "timestamps.log")
const LOGGED: Set<string> =
  ((globalThis as any).__opencodeTimestampsLogged ??= new Set<string>())
const PREFIX = "local-ts-footer-"

const pad = (value: number) => String(value).padStart(2, "0")

function fullStamp(ms: number) {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const hours = pad(Math.floor(Math.abs(offset) / 60))
  const minutes = pad(Math.abs(offset) % 60)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${String(date.getMilliseconds()).padStart(3, "0")}${sign}${hours}:${minutes}`
  )
}

function timeOnly(ms: number) {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function dateOnly(ms: number) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function readText(node: any): string {
  if (typeof node.plainText === "string") return node.plainText
  if (Array.isArray(node.chunks)) {
    return node.chunks
      .map((chunk: any) => (typeof chunk === "string" ? chunk : (chunk?.text ?? chunk?.value ?? "")))
      .join("")
  }
  if (typeof node.text === "string") return node.text
  if (typeof node.content === "string") return node.content
  return ""
}

class Stamp extends Renderable {
  constructor(
    context: RenderContext,
    private label: string,
    private color: RGBA,
    private background: RGBA,
    id: string,
    left: number,
    top: number,
  ) {
    super(context, {
      id,
      position: "absolute",
      top,
      left,
      width: label.length,
      height: 1,
      zIndex: 6,
    })
  }

  protected override renderSelf(buffer: OptimizedBuffer, _deltaTime: number) {
    for (let index = 0; index < this.label.length; index++) {
      buffer.setCell(
        this.screenX + index,
        this.screenY,
        this.label[index]!,
        this.color,
        this.background,
        0,
      )
    }
  }
}

export default Plugin.define({
  id: "local.timestamps-footer",
  setup(context) {
    let lastRun = 0
    let lastSession = ""
    let messages = new Map<string, any>()
    let labels = new Map<string, { box: any; label: Stamp; text: string; left: number; top: number }>()

    const refresh = () => {
      const route = context.ui.router.current()
      if (route?.type !== "session" || !route.sessionID) return
      if (route.sessionID !== lastSession) {
        lastSession = route.sessionID
        labels = new Map()
      }
      messages = new Map(
        (context.data.session.message.list(route.sessionID) ?? []).map((message: any) => [
          message.id,
          message,
        ]),
      )

      const msgNodes: Array<{ id: string; y: number; h: number }> = []
      const found: Array<{ node: any; parent: any; messageID: string; ts: number; text: string }> = []
      const walk = (node: any, parent: any, depth: number) => {
        if (depth > 50) return
        const id = typeof node.id === "string" ? node.id : ""
        const oldStamp =
          (id.startsWith("local-ts-") || id.startsWith("local-ts2-")) && !id.startsWith(PREFIX)
        if (oldStamp) {
          if (!node.isDestroyed) node.destroy()
          return
        }
        if (id.startsWith("msg_")) {
          msgNodes.push({ id, y: node.y, h: node.height })
        }
        const text = readText(node)
        if (/tok\/s/.test(text)) {
          if (parent) found.push({ node, parent, messageID: "", ts: NaN, text })
        }
        for (const child of node.getChildren?.() ?? []) walk(child, node, depth + 1)
      }
      walk(context.renderer.root, undefined, 0)

      const messageFor = (y: number) => {
        const containing = msgNodes
          .filter((item) => item.y <= y && y <= item.y + Math.max(item.h, 1))
          .sort((left, right) => right.y - left.y)[0]
        if (containing) return containing.id
        return msgNodes.filter((item) => item.y <= y).sort((left, right) => right.y - left.y)[0]?.id ?? ""
      }

      const resolved: typeof found = []
      for (const item of found) {
        const messageID = messageFor(item.node.y)
        const message = messages.get(messageID)
        const ts = message?.time?.created ?? message?.time?.completed
        if (messageID && typeof ts === "number") resolved.push({ ...item, messageID, ts })
      }
      if (resolved.length === 0) return

      const first = resolved.reduce((left, right) => (right.ts < left.ts ? right : left))
      const color = (context.theme.text as any).muted ?? context.theme.text.base
      const background = context.theme.background.base
      const seen = new Set<string>()

      for (const item of resolved) {
        const key = item.messageID
        seen.add(key)
        const text = item === first ? `${dateOnly(item.ts)} ${timeOnly(item.ts)}` : timeOnly(item.ts)
        const left = Math.max(
          0,
          Math.min(
            (item.parent.width ?? 0) - text.length - 1,
            item.node.x - item.parent.x + item.text.length + 1,
          ),
        )
        const top = Math.max(0, item.node.y - item.parent.y)
        const current = labels.get(key)
        if (
          current &&
          current.box === item.parent &&
          current.text === text &&
          current.left === left &&
          current.top === top &&
          !current.label.isDestroyed
        ) {
          continue
        }
        if (current) {
          if (!current.label.isDestroyed) current.label.destroy()
          labels.delete(key)
        }
        const label = new Stamp(
          context.renderer,
          text,
          color,
          background,
          `${PREFIX}${item.messageID}`,
          left,
          top,
        )
        item.parent.add(label)
        labels.set(key, { box: item.parent, label, text, left, top })

        const logKey = `${route.sessionID}|${item.messageID}|${item.ts}`
        if (!LOGGED.has(logKey)) {
          LOGGED.add(logKey)
          try {
            appendFileSync(
              LOG,
              `${fullStamp(item.ts)} session=${route.sessionID} message=${item.messageID} kind=footer\n`,
            )
          } catch {}
        }
      }

      for (const [key, current] of labels) {
        if (!seen.has(key) && (current.label.isDestroyed || current.box.isDestroyed)) {
          labels.delete(key)
        }
      }
    }

    const onFrame = () => {
      const now = Date.now()
      if (now - lastRun < 500) return
      lastRun = now
      try {
        refresh()
      } catch {}
    }

    context.renderer.on(CliRenderEvents.FRAME, onFrame)
    return () => {
      context.renderer.off(CliRenderEvents.FRAME, onFrame)
      for (const current of labels.values()) {
        if (!current.label.isDestroyed) current.label.destroy()
      }
      labels.clear()
    }
  },
})

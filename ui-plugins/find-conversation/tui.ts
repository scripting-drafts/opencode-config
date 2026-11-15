import { Plugin } from "@opencode/plugin/tui"

// Ctrl+F opens a searchable list of the current conversation. The palette
// command lives in a global layer so it stays discoverable while a dialog is
// open; the Ctrl+F binding lives in a base layer so it does not steal the key
// from dialogs, permission prompts, or the terminal pane.
const MAX_RESULTS = 200
const RECENT = 40

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const roleLabel = (message: any) => {
  if (message.type === "user") return "You"
  if (message.type === "assistant") return "Assistant"
  if (message.type === "compaction") return "Summary"
  return message.type
}

const messageText = (message: any) => {
  if (message.type === "user") return typeof message.text === "string" ? message.text : ""
  if (message.type === "assistant") {
    return (message.content ?? [])
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n")
  }
  if (message.type === "compaction") return typeof message.summary === "string" ? message.summary : ""
  return ""
}

const flatten = (text: string) => text.replace(/\s+/g, " ").trim()

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const timeLabel = (ms: number) => {
  if (!Number.isFinite(ms)) return ""
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

type Candidate = {
  id: string
  role: string
  text: string
  time: number
}

function options(query: string, candidates: Candidate[]) {
  const needle = query.trim()
  if (!needle) {
    return candidates
      .slice(-RECENT)
      .reverse()
      .map((candidate) => ({
        title: `${candidate.role}: ${flatten(candidate.text).slice(0, 110)}`,
        value: candidate.id,
        footer: timeLabel(candidate.time),
      }))
  }

  // Smartcase, literal matching: uppercase in the query makes it case-sensitive.
  const pattern = new RegExp(escapeRegExp(needle), /[A-Z]/.test(needle) ? "g" : "gi")
  const results = []
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index]!
    const text = flatten(candidate.text)
    if (!text) continue
    const matches = [...text.matchAll(pattern)]
    if (matches.length === 0) continue
    const first = matches[0]!
    const at = first.index ?? 0
    // Keep the match itself inside the visible title after dialog truncation.
    const start = Math.max(0, at - 12)
    const end = Math.min(text.length, at + needle.length + 48)
    const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
    results.push({
      title: `${candidate.role}: ${snippet}`,
      value: candidate.id,
      footer: `${timeLabel(candidate.time)}${matches.length > 1 ? ` · ${matches.length} matches` : ""}`,
    })
    if (results.length >= MAX_RESULTS) break
  }
  return results
}

function findNode(node: any, id: string): any {
  if (!node || node.isDestroyed) return undefined
  if (node.id === id) return node
  for (const child of node.getChildren?.() ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

function findScroll(node: any): any {
  for (let current = node; current; current = current.parent) {
    if (typeof current.scrollTo === "function" && typeof current.scrollTop === "number" && current.viewport) return current
  }
  return undefined
}

async function reveal(context: any, sessionID: string, targetID: string, messages: any[]) {
  const locate = () => findNode(context.renderer.root, targetID)

  let node = locate()
  if (!node) {
    // Message navigation mounts the rest of the transcript before jumping.
    context.keymap.dispatch("session.message.next")
    for (let attempt = 0; attempt < 40 && !node; attempt++) {
      await delay(50)
      node = locate()
    }
  }

  // A message inside a collapsed group may not have its own row. Fall back to
  // the nearest visible boundary so the result is still nearby.
  if (!node) {
    const index = messages.findIndex((message) => message.id === targetID)
    if (index >= 0) {
      for (let distance = 1; distance < messages.length && !node; distance++) {
        for (const at of [index - distance, index + distance]) {
          if (at < 0 || at >= messages.length) continue
          node = findNode(context.renderer.root, messages[at].id)
          if (node) break
        }
      }
    }
  }

  if (!node) return false

  const scroll = findScroll(node)
  if (!scroll) return false

  const message = messages.find((message) => message.id === targetID)
  const target = scroll.scrollTop + node.y - scroll.viewport.y
  const top = Math.max(0, target - (message?.type === "assistant" ? 1 : 0))
  const active = () => {
    const route = context.ui.router.current()
    return route.type === "session" && route.sessionID === sessionID
  }
  if (!active()) return false
  scroll.stickyScroll = false
  scroll.scrollTo(top)
  if (typeof scroll.afterLayout === "function") {
    scroll.afterLayout(() => {
      if (!scroll.isDestroyed && active()) scroll.scrollTo(top)
    })
  }
  return true
}

function createSearch(context: any) {
  let busy = false

  return async () => {
    if (busy) return
    const route = context.ui.router.current()
    if (route.type !== "session") return
    busy = true
    try {
      const sessionID = route.sessionID
      const loadMore = context.data.session.message.loadMore
      if (context.data.session.message.more?.(sessionID) && typeof loadMore === "function") {
        context.ui.toast.show({ message: "Loading conversation…", variant: "info", duration: 1200 })
        await loadMore(sessionID, { all: true }).catch(() => undefined)
      }

      const loaded = context.ui.router.current()
      if (loaded.type !== "session" || loaded.sessionID !== sessionID) return

      const messages = context.data.session.message.list(sessionID) ?? []
      const candidates: Candidate[] = messages.flatMap((message: any) => {
        const text = messageText(message)
        if (!text.trim()) return []
        return [
          {
            id: message.id,
            role: roleLabel(message),
            text,
            time: message.time?.created ?? 0,
          },
        ]
      })

      if (candidates.length === 0) {
        context.ui.toast.show({ message: "Nothing to search in this session", variant: "warning" })
        return
      }

      const selected = await context.ui.dialog.select<string>({
        title: "Find in conversation",
        placeholder: "Search messages",
        options: options("", candidates),
        search: (query: string) => options(query, candidates),
      })
      if (!selected) return

      const current = context.ui.router.current()
      if (current.type !== "session" || current.sessionID !== sessionID) return
      const ok = await reveal(context, sessionID, selected, messages)
      if (!ok) context.ui.toast.show({ message: "Could not locate that message", variant: "warning" })
    } finally {
      busy = false
    }
  }
}

export default Plugin.define({
  id: "local.find-conversation",
  setup(context) {
    const search = createSearch(context)

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "local.find-conversation",
          title: "Find in conversation",
          description: "ctrl+f",
          group: "Session",
          palette: true,
          enabled: () => context.ui.router.current().type === "session",
          run: search,
        },
      ],
    }))

    context.keymap.layer(() => ({
      mode: "base",
      commands: [
        {
          id: "local.find-conversation.key",
          title: "Find in conversation",
          group: "Session",
          bind: "ctrl+f",
          palette: false,
          enabled: () => {
            const route = context.ui.router.current()
            if (route.type !== "session") return false
            if (context.ui.panel.current()) return false
            const pending = context.data.session.permission.list(route.sessionID) ?? []
            return pending.length === 0
          },
          run: search,
        },
      ],
    }))
  },
})

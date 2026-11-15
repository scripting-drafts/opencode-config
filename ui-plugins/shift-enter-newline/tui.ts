import { Plugin } from "@opencode/plugin/tui"
import { dlopen, FFIType } from "bun:ffi"

type ShiftState = {
  readonly held: () => boolean
  readonly dispose: () => void
}

// Terminals without the Kitty keyboard protocol (for example, GNOME
// Terminal with VTE 0.68 or Terminal.app) send a bare Return for
// Shift+Enter. Ask the windowing system for the physical modifier state.
function createShiftState(): ShiftState {
  if (process.platform === "linux") {
    try {
      const x11 = dlopen("libX11.so.6", {
        XOpenDisplay: { args: [FFIType.ptr], returns: FFIType.ptr },
        XCloseDisplay: { args: [FFIType.ptr], returns: FFIType.i32 },
        XKeysymToKeycode: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u8 },
        XQueryKeymap: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      })
      const display = x11.symbols.XOpenDisplay(null)
      if (!display) return { held: () => false, dispose: () => {} }
      const left = x11.symbols.XKeysymToKeycode(display, 0xffe1)
      const right = x11.symbols.XKeysymToKeycode(display, 0xffe3)
      const keys = new Uint8Array(32)
      const down = (keycode: number) => (keys[keycode >> 3]! & (1 << (keycode & 7))) !== 0
      return {
        held: () => {
          x11.symbols.XQueryKeymap(display, keys)
          return down(left) || down(right)
        },
        dispose: () => x11.symbols.XCloseDisplay(display),
      }
    } catch {
      return { held: () => false, dispose: () => {} }
    }
  }

  if (process.platform === "darwin") {
    try {
      const cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
        CGEventSourceFlagsState: { args: [FFIType.i32], returns: FFIType.u64 },
      })
      return {
        held: () => (Number(cg.symbols.CGEventSourceFlagsState(0)) & 0x00020000) !== 0,
        dispose: () => {},
      }
    } catch {
      return { held: () => false, dispose: () => {} }
    }
  }

  if (process.platform === "win32") {
    try {
      const user32 = dlopen("user32.dll", {
        GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
      })
      return {
        held: () => (user32.symbols.GetAsyncKeyState(0x10) & 0x8000) !== 0,
        dispose: () => {},
      }
    } catch {
      return { held: () => false, dispose: () => {} }
    }
  }

  return { held: () => false, dispose: () => {} }
}

export default Plugin.define({
  id: "local.shift-enter-newline",
  setup(context) {
    const shift = createShiftState()

    context.keymap.layer(() => ({
      mode: "base",
      priority: 100,
      commands: [
        {
          id: "local.shift-enter-newline.enter",
          bind: "return",
          run(_input, event) {
            if (!event || (event.name !== "return" && event.name !== "kpenter")) return false
            if (!shift.held()) return false

            const editor = context.renderer.currentFocusedEditor as { newLine?: () => boolean } | null | undefined
            if (!editor || typeof editor.newLine !== "function") return false
            return editor.newLine() ? undefined : false
          },
        },
      ],
    }))

    return shift.dispose
  },
})

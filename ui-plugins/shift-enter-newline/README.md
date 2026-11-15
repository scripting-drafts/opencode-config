# Shift+Enter newline

Some terminals send a bare Return for Shift+Enter because they do not implement
the Kitty keyboard protocol (for example, VTE 0.68 or Terminal.app). This TUI
plugin asks the windowing system for the physical Shift state and inserts a newline.

- Linux/X11: libX11 `XQueryKeymap`
- macOS: CoreGraphics `CGEventSourceFlagsState`
- Windows: `GetAsyncKeyState`
- Wayland without X11: falls back to the terminal's own bindings (`ctrl+j`, `alt+enter`)

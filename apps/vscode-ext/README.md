# CCHUB Focus — VS Code extension

Focuses the exact integrated terminal of a session, by the shell process PID, triggered by
the URI `vscode://vbss.cch-focus/focus?pid=<shellPid>`. This is the piece that makes **Focus**
precise when several Claudes run in integrated terminals of the same VS Code window.

## How it fits the pipeline

`Focus` in VBSS CCHUB already brings the host window to the front (Win32). When that window is
VS Code, the hook (`notify.mjs`) also captures the session's **shell PID** (the first shell
ancestor in the process tree) and the hub fires the URI above on focus, so this extension can
raise the right terminal inside the window. Outside VS Code the shell PID is not sent, so the
URI is never fired — no side effects.

## Install (dev)

Copy the folder into your VS Code extensions and reload:

```bash
cp -r "C:/path/to/vbss-cchub/apps/vscode-ext" "$HOME/.vscode/extensions/vbss.cch-focus-1.0.0"
```

Then, in VS Code: `Ctrl+Shift+P` → "Developer: Reload Window".

(Alternative: open `apps/vscode-ext` in VS Code and press `F5` → opens an Extension Dev Host
to test without installing.)

## Test end-to-end

1. Open VS Code, start 2–3 integrated terminals and run a `claude` session in each.
2. In VBSS CCHUB, click **Focus** on a card whose session runs in one of those terminals.
3. Expected: VS Code comes to the front (hub) **and** the exact terminal of that session is
   raised (this extension).

Manual check without the hub:

1. `Ctrl+Shift+P` → **CCHUB: List terminals and PIDs** → note a terminal's `pid`.
2. From any shell, fire the URI at another terminal:

   ```bash
   code --open-url "vscode://vbss.cch-focus/focus?pid=<PID>"
   ```

3. Expected: VS Code focuses exactly that terminal.

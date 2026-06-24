/**
 * Helpers for launching and recognizing Claude Code terminals.
 *
 * A "Claude tab" is a terminal whose initial command runs Claude Code. It used
 * to be detected by matching the literal `claude` command, but the command can
 * now be a full path (e.g. `/opt/homebrew/bin/claude`, or a quoted Windows
 * `.cmd` shim) when the user sets a Claude binary path in settings. So detection
 * matches the *basename* of the command's first token instead, which recognizes
 * both forms plus the flags Claude tabs append (`--dangerously-skip-permissions`,
 * `--mcp-config`, …).
 */

/** Extract the first token of a command line, honoring a leading quoted path. */
function firstToken(command: string): string {
  const trimmed = command.trim();
  // A PowerShell call-operator prefix (`& "C:\…\claude.cmd"`) — skip the `&`.
  const body = trimmed.startsWith("& ") ? trimmed.slice(2).trim() : trimmed;
  const quote = body[0];
  if (quote === '"' || quote === "'") {
    const end = body.indexOf(quote, 1);
    return end === -1 ? body.slice(1) : body.slice(1, end);
  }
  return body.split(/\s+/)[0] ?? "";
}

/** Whether a terminal's initial command launches Claude Code. */
export function isClaudeCommand(command: string | undefined | null): boolean {
  if (!command) return false;
  const first = firstToken(command);
  if (!first) return false;
  const base = first
    .replace(/\\/g, "/") // normalize Windows separators
    .split("/")
    .pop()!
    .toLowerCase()
    .replace(/\.(cmd|exe|bat|ps1)$/, "");
  return base === "claude";
}

/**
 * Build the leading token of a Claude launch command from a configured binary
 * path. An empty/whitespace path → the bare `claude` command (resolved on PATH).
 * Paths with spaces are double-quoted (works across POSIX shells and cmd); under
 * PowerShell a quoted path needs the call operator, so prefix `& `.
 */
export function claudeBaseCommand(
  path: string | null | undefined,
  shellProgram: string | null | undefined,
): string {
  const p = path?.trim();
  if (!p) return "claude";
  if (!/[\s"']/.test(p)) return p; // no quoting needed
  const quoted = `"${p}"`;
  const isPowerShell = /powershell|pwsh/i.test(shellProgram ?? "");
  return isPowerShell ? `& ${quoted}` : quoted;
}

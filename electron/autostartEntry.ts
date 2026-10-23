/** XDG autostart entry for Linux (pure; see the Desktop Entry spec "Exec key" quoting rules). */

/** Quotes one Exec argument when needed, escaping the characters the spec reserves. */
export function quoteExecArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `"${arg.replace(/([\\"`$])/g, '\\$1')}"`
}

export function linuxAutostartEntry(name: string, exec: string, args: readonly string[], comment: string): string {
  // In a .desktop file a literal % must be doubled.
  const execLine = [exec, ...args].map(quoteExecArg).join(' ').replace(/%/g, '%%')
  const clean = (s: string) => s.replace(/[\r\n]/g, ' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${clean(name)}`,
    `Comment=${clean(comment)}`,
    `Exec=${execLine}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

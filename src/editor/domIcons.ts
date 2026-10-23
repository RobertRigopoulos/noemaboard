/**
 * Line icons for plain-DOM editor node views, which cannot render lucide-react components. The
 * geometry is lucide's (ISC licence, the same set the rest of the app uses), so they match.
 */

type IconNode = readonly (readonly [string, Readonly<Record<string, string>>])[]

const CALENDAR: IconNode = [
  ['path', { d: 'M8 2v3' }],
  ['path', { d: 'M16 2v3' }],
  ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
  ['path', { d: 'M3 9h18' }],
]

const USER_ROUND: IconNode = [
  ['circle', { cx: '12', cy: '8', r: '5' }],
  ['path', { d: 'M20 21a8 8 0 0 0-16 0' }],
]

const SVG_NS = 'http://www.w3.org/2000/svg'

function icon(nodes: IconNode, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const attrs: Record<string, string> = {
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v)
  for (const [tag, a] of nodes) {
    const el = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, v)
    svg.appendChild(el)
  }
  return svg
}

export const calendarIcon = (size = 14) => icon(CALENDAR, size)
export const userRoundIcon = (size = 14) => icon(USER_ROUND, size)

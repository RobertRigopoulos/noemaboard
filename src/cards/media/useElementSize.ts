import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export interface ElementSize {
  w: number
  h: number
}

/**
 * Content-box size of an element, kept up to date with a ResizeObserver. Returns a callback ref to put
 * on the element (it follows the element when it is replaced, e.g. when a view switches) and a plain
 * ref for reading the element in handlers.
 */
export function useElementSize<T extends HTMLElement = HTMLDivElement>(): {
  ref: (el: T | null) => void
  el: RefObject<T | null>
  /** The element as state, for effects that attach listeners to it. */
  node: T | null
  size: ElementSize
} {
  const el = useRef<T | null>(null)
  const [node, setNode] = useState<T | null>(null)
  const [size, setSize] = useState<ElementSize>({ w: 0, h: 0 })
  const ref = useCallback((next: T | null) => {
    el.current = next
    setNode(next)
  }, [])
  useLayoutEffect(() => {
    if (!node) return
    const update = () => {
      const w = node.clientWidth
      const h = node.clientHeight
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }))
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const ro = new ResizeObserver(update)
    ro.observe(node)
    return () => ro.disconnect()
  }, [node])
  return { ref, el, node, size }
}

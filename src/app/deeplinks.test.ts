import { describe, expect, it } from 'vitest'
import { deepLinkToRoute } from './deeplinks'

describe('deepLinkToRoute', () => {
  const payload = 'eyJiIjoiYWJjZGVmZ2hpams'

  it('maps desktop invite links', () => {
    expect(deepLinkToRoute(`noema://join/${payload}`)).toBe(`/join/${payload}`)
    expect(deepLinkToRoute(`NOEMA://join/${payload}/`)).toBe(`/join/${payload}`)
  })

  it('maps web invite links pasted into the scheme', () => {
    expect(deepLinkToRoute(`https://example.github.io/app/#/join/${payload}`)).toBe(`/join/${payload}`)
  })

  it('rejects other links and junk', () => {
    expect(deepLinkToRoute('noema://open/board')).toBeNull()
    expect(deepLinkToRoute('noema://join/')).toBeNull()
    expect(deepLinkToRoute(`noema://join/${payload}<script>`)).toBe(`/join/${payload}`)
    expect(deepLinkToRoute(42)).toBeNull()
    expect(deepLinkToRoute(`noema://join/${'a'.repeat(9000)}`)).toBeNull()
  })
})

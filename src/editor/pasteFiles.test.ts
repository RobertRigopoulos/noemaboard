import { describe, expect, it } from 'vitest'
import { htmlIsOnlyDataImages, isFilesOnlyPaste } from './pasteFiles'

describe('htmlIsOnlyDataImages', () => {
  it('accepts HTML that is only inline pictures', () => {
    expect(htmlIsOnlyDataImages('<img src="data:image/png;base64,AAAA">')).toBe(true)
    expect(htmlIsOnlyDataImages('<meta charset="utf-8"><img src="data:image/png;base64,AAAA" alt="x"/>')).toBe(true)
    expect(htmlIsOnlyDataImages('<html><body><!--StartFragment--><img src=\'data:image/jpeg;base64,/9j/\'><!--EndFragment--></body></html>')).toBe(true)
    expect(htmlIsOnlyDataImages('<div><img src="data:image/png;base64,A"><br><img src="data:image/gif;base64,B"></div>')).toBe(true)
  })

  it('rejects anything with text or remote pictures', () => {
    expect(htmlIsOnlyDataImages('')).toBe(false)
    expect(htmlIsOnlyDataImages('<p>Hello</p>')).toBe(false)
    expect(htmlIsOnlyDataImages('<img src="https://example.com/a.png">')).toBe(false)
    expect(htmlIsOnlyDataImages('<img src="data:image/png;base64,A"><p>caption</p>')).toBe(false)
    expect(htmlIsOnlyDataImages('<img src="data:text/html;base64,A">')).toBe(false)
  })
})

describe('isFilesOnlyPaste', () => {
  it('needs files, and either no text or only inline pictures', () => {
    expect(isFilesOnlyPaste(0, '', '')).toBe(false)
    expect(isFilesOnlyPaste(1, '', '')).toBe(true)
    expect(isFilesOnlyPaste(2, '  \n', '')).toBe(true)
    expect(isFilesOnlyPaste(1, 'shot.png', '<img src="data:image/png;base64,A">')).toBe(true)
    expect(isFilesOnlyPaste(1, 'Quarterly numbers', '<table><tr><td>1</td></tr></table>')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { asText, cleanFileName, cleanText, downloadName, fileExtension, fileKind, formatBytes, guessMime, truncate, typeLabel } from './format'

describe('formatBytes', () => {
  it('formats sizes in binary units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(123.4 * 1024)).toBe('123 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatBytes(2.25 * 1024 * 1024)).toBe('2.3 MB')
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 MB')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB')
    expect(formatBytes(3 * 1024 ** 4)).toBe('3 TB')
  })

  it('promotes values that round up to the next unit', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 MB')
  })

  it('handles junk', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(NaN)).toBe('0 B')
    expect(formatBytes('12')).toBe('0 B')
    expect(formatBytes(Infinity)).toBe('0 B')
  })
})

describe('text helpers', () => {
  it('asText only passes strings, capped', () => {
    expect(asText('hello', 10)).toBe('hello')
    expect(asText('hello world', 5)).toBe('hello')
    expect(asText({ evil: true }, 10)).toBe('')
    expect(asText(5, 10)).toBe('')
  })

  it('cleanText collapses whitespace and strips control/bidi characters', () => {
    expect(cleanText('  A\n\ttitle\u0000 with ‮spoof ', 100)).toBe('A title with spoof')
    expect(cleanText('x'.repeat(500), 300)).toHaveLength(300)
    expect(cleanText(null, 10)).toBe('')
  })

  it('truncate never splits a surrogate pair', () => {
    expect(truncate('ab😀', 3)).toBe('ab')
    expect(truncate('ab😀', 4)).toBe('ab😀')
  })
})

describe('file names and types', () => {
  it('cleans file names', () => {
    expect(cleanFileName('report.pdf')).toBe('report.pdf')
    expect(cleanFileName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(cleanFileName('a<b>:c?.txt')).toBe('a_b_c_.txt')
    expect(cleanFileName('name. ')).toBe('name')
    expect(cleanFileName('.env')).toBe('.env')
    expect(cleanFileName('', 'fallback')).toBe('fallback')
    expect(cleanFileName(42, 'fallback')).toBe('fallback')
  })

  it('strips invisible format characters that can disguise the real extension', () => {
    // RIGHT-TO-LEFT OVERRIDE makes "Invoice_2024‮fdp.exe" display as "Invoice_2024exe.pdf".
    expect(cleanFileName('Invoice_2024‮fdp.exe')).toBe('Invoice_2024fdp.exe')
    expect(cleanFileName('a⁦b⁧c⁨d⁩e‪f‫g‬h‭i.txt')).toBe('abcdefghi.txt')
    expect(cleanFileName('x‎y‏z؜​﻿.pdf')).toBe('xyz.pdf')
    expect(cleanFileName('report\u0085.pdf')).toBe('report_.pdf')
    // Joiners are kept: emoji sequences and Persian words need them.
    expect(cleanFileName('👩‍💻 notes.txt')).toBe('👩‍💻 notes.txt')
    expect(cleanFileName('می‌خواهم.txt')).toBe('می‌خواهم.txt')
    expect(cleanFileName('‮‮', 'fallback')).toBe('fallback')
  })

  it('takes the kind from the extension when the claimed MIME type disagrees', () => {
    expect(fileKind('application/pdf', 'Invoice_2024fdp.exe')).toBe('other')
    expect(fileKind('application/pdf', 'scan.pdf')).toBe('pdf')
    expect(fileKind('image/png', 'photo.zip')).toBe('archive')
    expect(fileKind('application/octet-stream', 'scan.pdf')).toBe('pdf')
    expect(fileKind('text/html', 'page.html')).toBe('other')
    // Audio / video containers may be labelled either way.
    expect(fileKind('audio/webm', 'voice.webm')).toBe('audio')
    expect(fileKind('video/ogg', 'clip.ogg')).toBe('video')
  })

  it('reads extensions', () => {
    expect(fileExtension('Report.PDF')).toBe('pdf')
    expect(fileExtension('archive.tar.gz')).toBe('gz')
    expect(fileExtension('README')).toBe('')
  })

  it('classifies files by MIME type, then extension', () => {
    expect(fileKind('application/pdf', 'x')).toBe('pdf')
    expect(fileKind('', 'x.pdf')).toBe('pdf')
    expect(fileKind('image/heic', 'x.heic')).toBe('image')
    expect(fileKind('audio/mpeg', 'song')).toBe('audio')
    expect(fileKind('', 'song.flac')).toBe('audio')
    expect(fileKind('video/quicktime', 'clip.mov')).toBe('video')
    expect(fileKind('application/zip', 'a.zip')).toBe('archive')
    expect(fileKind('application/x-7z-compressed', 'a.7z')).toBe('archive')
    expect(fileKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx')).toBe('spreadsheet')
    expect(fileKind('text/csv', 'a.csv')).toBe('spreadsheet')
    expect(fileKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toBe('document')
    expect(fileKind('text/plain', 'a.txt')).toBe('document')
    expect(fileKind('application/octet-stream', 'a.bin')).toBe('other')
    expect(fileKind('', 'noext')).toBe('other')
  })

  it('guesses missing MIME types from the extension', () => {
    expect(guessMime('a.mp3', '')).toBe('audio/mpeg')
    expect(guessMime('a.webp', 'application/octet-stream')).toBe('image/webp')
    expect(guessMime('a.png', 'image/png')).toBe('image/png')
    expect(guessMime('a.weird', '')).toBe('application/octet-stream')
  })

  it('labels file types', () => {
    expect(typeLabel('a.pdf', 'application/pdf')).toBe('PDF')
    expect(typeLabel('noext', 'audio/mpeg')).toBe('MPEG')
    expect(typeLabel('noext', 'application/octet-stream')).toBe('File')
  })

  it('fixes the extension of re-encoded images on download', () => {
    expect(downloadName('photo.jpg', 'image/webp')).toBe('photo.webp')
    expect(downloadName('photo.JPEG', 'image/jpeg')).toBe('photo.JPEG')
    expect(downloadName('photo.jpg', 'image/jpeg')).toBe('photo.jpg')
    expect(downloadName('Pasted image', 'image/png')).toBe('Pasted image.png')
    expect(downloadName('report.pdf', 'application/pdf')).toBe('report.pdf')
    expect(downloadName('notes.v2', 'image/png')).toBe('notes.v2.png')
    expect(downloadName('', 'application/pdf')).toBe('file')
  })
})

/**
 * Deciding whether a paste into text is "just files" (a screenshot, files copied in a file manager)
 * that text cannot hold, or text that happens to come with a picture of itself.
 */

/** Markup that carries nothing visible: document scaffolding, meta tags, comments, line breaks. */
const SCAFFOLDING = /<!--[\s\S]*?-->|<\/?(?:html|head|body|meta|span|div|p|br)\b[^>]*>|&nbsp;|\s+/gi
const DATA_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*(["']?)data:image\/[a-z0-9.+-]+[;,][^>]*>/gi

/**
 * True when HTML holds nothing but inline (data: URL) images, which is how some apps put a
 * screenshot on the clipboard next to the file itself.
 */
export function htmlIsOnlyDataImages(html: string): boolean {
  if (!html) return false
  const withoutImages = html.replace(DATA_IMAGE, '')
  if (withoutImages.length === html.length) return false
  return withoutImages.replace(SCAFFOLDING, '') === ''
}

/**
 * True when a paste with files should be treated as files: there is no text to paste instead, or
 * the HTML is only inline copies of the same pictures. (Office apps add a picture of copied text;
 * callers rule those out separately.)
 */
export function isFilesOnlyPaste(fileCount: number, text: string, html: string): boolean {
  if (fileCount <= 0) return false
  return !text.trim() || htmlIsOnlyDataImages(html)
}

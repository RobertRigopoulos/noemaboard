/**
 * Runs inside the app page while recording (served by the app's Vite dev server, imported by
 * record.cjs), and sets up the demo boards with the app's own code. Everything lives in the
 * recording window's throwaway storage.
 */
import { docs } from '/src/collab/docs.ts'
import { useLibrary } from '/src/collab/library.ts'
import { getUser, useIdentity } from '/src/collab/identity.ts'
import { createInvite, ensureHome, joinBoard } from '/src/collab/boards.ts'
import { putBlob } from '/src/collab/blobs.ts'
import { useNetworkSettings } from '/src/collab/sync/settings.ts'
import { createCard, getCards, initBoardDoc } from '/src/model/board.ts'
import { newBoardId, newSecret } from '/src/model/ids.ts'
import { layout } from '/src/templates/writer.ts'
import { heading, paragraph, tasks } from '/src/templates/richText.ts'
import { createBoardFromTemplate } from '/src/templates/create.ts'
import { openBoard } from '/src/app/router.ts'
import { useSelection, useView } from '/src/board/store.ts'
import { HOME_BOARD_ID } from '/src/config.ts'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(test, what, ms = 8000) {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** Names this window's person, keeps sync on this computer, and fakes the clipboard (none here). */
export async function setup(name, color) {
  useIdentity.getState().setProfile({ name, color })
  // Shared boards sync through the local relay only; no public matchmaking during recording.
  useNetworkSettings.getState().update({ p2pEnabled: false })
  if (navigator.clipboard) navigator.clipboard.writeText = async () => {}
  await ensureHome()
  return getUser().id
}

/** A board on Home filled by `build(writer, ids)`; returns its id and the ids `build` collected. */
async function newBoard({ title, icon = null, color = null, at, build }) {
  const uid = getUser().id
  const id = newBoardId()
  const secret = newSecret()
  const ids = {}
  useLibrary.getState().upsert({ id, secret, title, icon, color, parentId: HOME_BOARD_ID })
  await docs.withDoc(id, (doc) => {
    initBoardDoc(doc, { id, title, icon, color, parentId: HOME_BOARD_ID, shared: false }, uid)
    layout((w) => build(w, ids, doc))(doc, uid)
  })
  await docs.withDoc(HOME_BOARD_ID, (home) => createCard(home, 'board', { ...at, boardId: id, secret, title, icon, color }, uid))
  return { id, ids }
}

/**
 * The demo boards are two columns of 280-wide cards (about 600 CSS pixels across), so one crop of the
 * window shows a whole board in every video format, phone-shaped included.
 */

/** Scene "add anything": a title, a to-do list and a link, with room on the right for new cards. */
export async function launchBoard() {
  // The link card's preview picture: NoemaBoard's own (served by the dev server from site/).
  const preview = await putBlob(await (await fetch('/site/og.png')).blob())
  const url = 'https://noemaboard.app'
  const board = await newBoard({
    title: 'Product launch',
    icon: 'rocket',
    color: 'blue',
    at: { x: 80, y: 80 },
    build: (w, ids) => {
      ids.title = w.note({ x: 0, y: 0 }, [heading(1, 'Product launch'), paragraph('Everything for launch day, in one place.')], { w: 280 })
      ids.todo = w.todo(
        { x: 0, y: w.below(ids.title, 24) },
        'This week',
        tasks('Write the announcement', 'Record a short demo', 'Share the link'),
        { w: 280, color: 'yellow' },
      )
      ids.link = createCard(
        w.doc,
        'link',
        {
          x: 0,
          y: w.below(ids.todo, 24),
          w: 280,
          url,
          previewFor: url,
          previewState: 'done',
          title: 'NoemaBoard',
          description: 'Free visual boards you edit together.',
          siteName: 'noemaboard.app',
          imageBlob: preview.hash,
        },
        w.userId,
      )
    },
  })
  await createInvite(board.id)
  return board
}

/** Scene "organise": two columns, a loose card to drag in, and a board inside the board. */
export async function planBoard() {
  const board = await newBoard({
    title: 'Launch plan',
    icon: 'kanban',
    color: 'purple',
    at: { x: 260, y: 80 },
    build: (w, ids) => {
      const todo = (ids.todoColumn = w.column({ x: 0, y: 0 }, 'To do', { w: 280 }))
      const doing = (ids.doing = w.column({ x: 300, y: 0 }, 'In progress', { w: 280, color: 'yellow' }))
      w.note({ column: todo }, [heading(3, 'Blog post'), paragraph('Why we built it, in five short paragraphs.')])
      w.todo({ column: todo }, 'Social posts', tasks('LinkedIn', 'X', 'Instagram'))
      w.todo({ column: doing }, 'Landing page', tasks({ text: 'Headline', done: true }, 'Screenshots', 'Downloads'))
      ids.looseY = Math.max(w.below(todo, 30), w.below(doing, 30))
      ids.loose = w.note({ x: 0, y: ids.looseY }, [heading(3, 'Record the demo'), paragraph('Two people, one board, 30 seconds.')], { w: 280, color: 'pink' })
    },
  })
  // A real board inside the board, filled from the app's own moodboard template.
  const moodboard = await docs.withDoc(board.id, (doc) => createBoardFromTemplate(doc, 'moodboard', { x: 440, y: board.ids.looseY + 60 }))
  board.ids.moodboard = moodboard
  // Opens at a zoom where its colours and notes fit the same column as the other boards.
  const { boardId: current } = useView.getState()
  useView.setState({ boardId: moodboard })
  useView.getState().setViewport({ x: 272, y: 30, zoom: 0.75 })
  useView.setState({ boardId: current })
  board.ids.moodboardCard = await docs.withDoc(board.id, (doc) => {
    const card = [...getCards(doc).values()].find((m) => m.get('type') === 'board' && m.get('boardId') === moodboard)
    return card?.get('id') ?? null
  })
  return board
}

/** Scene "together": a board two people work on at once. Returns the invite for the second person. */
export async function teamBoard() {
  const board = await newBoard({
    title: 'Launch day',
    icon: 'megaphone',
    color: 'orange',
    at: { x: 440, y: 80 },
    build: (w, ids) => {
      ids.title = w.note({ x: 0, y: 0 }, [heading(1, 'Launch day')], { w: 280 })
      ids.post = w.note({ x: 0, y: w.below(ids.title, 24) }, [heading(3, 'Announcement')], { w: 280, color: 'yellow' })
      ids.checklist = w.todo({ x: 300, y: 0 }, 'Checklist', tasks({ text: 'Final test', done: true }, 'Publish the post', 'Celebrate'), { w: 280, color: 'green' })
      ids.photo = w.note({ x: 300, y: w.below(ids.checklist, 24) }, [heading(3, 'Photo ideas'), paragraph('The team around one screen.')], { w: 280, color: 'pink' })
    },
  })
  const invite = await createInvite(board.id)
  return { ...board, invite: invite?.payload ?? null }
}

/** The second person joins with the first person's invite. */
export async function join(payload) {
  await joinBoard(payload)
  return payload.b
}

/** Opens a board and places the view: `view` is { x, y, zoom } in screen pixels. */
export async function show(boardId, view) {
  openBoard(boardId)
  await until(() => document.querySelector('.world') && useView.getState().boardId === boardId, 'the board to open')
  await sleep(400)
  useSelection.getState().clear()
  useView.getState().setViewport(view)
  await sleep(300)
}

/** Viewport rectangle of an element, or null. */
export function rect(selector) {
  const el = document.querySelector(selector)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
}

export function cardRect(cardId) {
  return rect(`#card-${CSS.escape(cardId)}`)
}

/** Rectangle of the visible button whose text contains `text`. */
export function buttonRect(text) {
  const el = [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.includes(text))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
}

/** Rectangles of the task checkboxes on a card. */
export function checkboxRects(cardId) {
  const card = document.getElementById(`card-${cardId}`)
  if (!card) return []
  return [...card.querySelectorAll('li[data-type="taskItem"] input[type="checkbox"]')].map((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
}

/** A landscape picture drawn here (no stock photos needed), in the moodboard template's colours. */
async function pictureFile() {
  const c = new OffscreenCanvas(1200, 800)
  const g = c.getContext('2d')
  const sky = g.createLinearGradient(0, 0, 0, 800)
  sky.addColorStop(0, '#24324a')
  sky.addColorStop(1, '#3f7f7a')
  g.fillStyle = sky
  g.fillRect(0, 0, 1200, 800)
  g.fillStyle = '#f2c23b'
  g.beginPath()
  g.arc(820, 300, 130, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#a9c5b6'
  g.beginPath()
  g.moveTo(0, 600)
  g.quadraticCurveTo(320, 430, 640, 580)
  g.quadraticCurveTo(900, 690, 1200, 520)
  g.lineTo(1200, 800)
  g.lineTo(0, 800)
  g.fill()
  g.fillStyle = '#df7a5e'
  g.beginPath()
  g.moveTo(0, 700)
  g.quadraticCurveTo(420, 590, 760, 690)
  g.quadraticCurveTo(1000, 760, 1200, 680)
  g.lineTo(1200, 800)
  g.lineTo(0, 800)
  g.fill()
  const blob = await c.convertToBlob({ type: 'image/png' })
  return new File([blob], 'launch-poster.png', { type: 'image/png' })
}

/** Drops a picture file on the canvas at a viewport point, as dragging it in from the desktop does. */
export async function dropPicture(clientX, clientY) {
  const file = await pictureFile()
  const target = document.elementFromPoint(clientX, clientY)
  const dt = new DataTransfer()
  dt.items.add(file)
  for (const type of ['dragenter', 'dragover', 'drop']) {
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: dt }))
  }
}

/** Ends editing and clears the selection, so the recording starts clean. */
export function idle() {
  useSelection.getState().setEditing(null)
  useSelection.getState().clear()
}

/** Text of the sync status pill in the header. */
export function syncLabel() {
  return document.querySelector('.sync-pill__label')?.textContent ?? ''
}

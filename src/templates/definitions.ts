/**
 * The built-in board templates. All text is original, short and generic so it reads as an
 * example to replace, not as content to keep.
 */
import { CalendarDays, Clapperboard, Lightbulb, NotebookPen, Palette, RefreshCcw, SquareKanban } from 'lucide-react'
import { DEFAULT_SIZE, type CardColor } from '../model/types'
import type { BoardTemplate } from './types'
import { bullets, heading, numbered, paragraph, tasks } from './richText'
import { layout } from './writer'

const COL_W = DEFAULT_SIZE.column.w
/** Horizontal gap between side-by-side columns and cards. */
const GAP = 30

export const projectPlan: BoardTemplate = {
  id: 'project-plan',
  name: 'Project plan',
  description: 'Track tasks from to-do to done in three columns.',
  icon: SquareKanban,
  color: 'blue',
  boardIcon: 'kanban',
  build: layout((w) => {
    const intro = w.note(
      { x: 0, y: 0 },
      [heading(1, 'Project plan'), paragraph('Give every task a card and move it to the right as the work moves along.')],
      { w: COL_W * 2 + GAP },
    )
    const y = w.below(intro)
    const todo = w.column({ x: 0, y }, 'To do')
    const doing = w.column({ x: COL_W + GAP, y }, 'In progress', { color: 'yellow' })
    const done = w.column({ x: 2 * (COL_W + GAP), y }, 'Done', { color: 'green' })

    w.todo({ column: todo }, 'Getting started', tasks('Agree on the goal', 'Choose a deadline', 'Invite the team'))
    w.note({ column: todo }, [heading(3, 'Research'), paragraph('Gather examples, numbers and notes that will shape the plan.')])
    w.note({ column: todo }, [heading(3, 'First draft'), paragraph('Turn the research into a rough plan and share it early.')])

    w.note({ column: doing }, [heading(3, 'Design'), paragraph('Sketch the main ideas and ask for feedback.')])
    w.todo({ column: doing }, 'Review', tasks({ text: 'Book a review session', done: true }, 'Collect comments', 'Agree on changes'))

    w.note({ column: done }, [heading(3, 'Kick-off'), paragraph('Everyone knows the goal and their part in it.')])
  }),
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const DAY_W = 240
const DAY_GAP = 20

export const weeklyPlanner: BoardTemplate = {
  id: 'weekly-planner',
  name: 'Weekly planner',
  description: 'A column for every day and goals for the week.',
  icon: CalendarDays,
  color: 'teal',
  boardIcon: 'calendar',
  build: layout((w) => {
    const intro = w.note(
      { x: 0, y: 0 },
      [heading(1, 'Weekly planner'), paragraph('Plan each day, then tick things off as you go. Move anything unfinished to the next day.')],
      { w: DAY_W * 2 + DAY_GAP },
    )
    const goals = w.todo(
      { x: 2 * (DAY_W + DAY_GAP), y: 0 },
      'This week’s goals',
      tasks('One important thing to finish', 'Something new to learn', 'Time just for you'),
      { color: 'teal' },
    )
    const y = Math.max(w.below(intro), w.below(goals))
    const days = DAYS.map((day, i) => w.column({ x: i * (DAY_W + DAY_GAP), y }, day, { w: DAY_W, color: i >= 5 ? 'teal' : null }))

    w.todo({ column: days[0] }, 'Focus', tasks('Plan the week', 'Check in with the team'))
    w.note({ column: days[2] }, [paragraph('Midweek check: still on track?')])
    w.note({ column: days[4] }, [paragraph('Wrap up the week and note what went well.')])
    w.note({ column: days[6] }, [paragraph('Rest and recharge.')])
  }),
}

const IDEAS: { title: string; text: string; color: CardColor }[] = [
  { title: 'What if…?', text: 'Flip the problem upside down.', color: 'yellow' },
  { title: 'Quick win', text: 'Something we could try tomorrow.', color: 'orange' },
  { title: 'Big swing', text: 'The bold version, with no limits.', color: 'pink' },
  { title: 'Who is it for?', text: 'Picture the people it helps.', color: 'purple' },
  { title: 'Borrow an idea', text: 'What works well somewhere else?', color: 'blue' },
  { title: 'Wild card', text: 'The odd one out. Keep it anyway.', color: 'green' },
]

export const brainstorm: BoardTemplate = {
  id: 'brainstorm',
  name: 'Brainstorm',
  description: 'A central question with ideas branching out.',
  icon: Lightbulb,
  color: 'yellow',
  boardIcon: 'lightbulb',
  build: layout((w) => {
    const main = w.note({ x: 0, y: 0 }, [heading(1, 'Main topic'), paragraph('What are we trying to figure out? Write it here.')], { w: 300 })
    w.centerOn(main, 0, 0)
    // Six ideas on an ellipse around the topic: top, upper right, lower right, bottom, lower left, upper left.
    IDEAS.forEach((idea, i) => {
      const angle = ((-90 + i * 60) * Math.PI) / 180
      const id = w.note({ x: 0, y: 0 }, [heading(3, idea.title), paragraph(idea.text)], { w: 220, color: idea.color })
      w.centerOn(id, Math.cos(angle) * 470, Math.sin(angle) * 270)
      w.line(main, id, { arrowEnd: false })
    })
  }),
}

const PALETTE = [
  { hex: '#24324a', name: 'Midnight' },
  { hex: '#3f7f7a', name: 'Juniper' },
  { hex: '#a9c5b6', name: 'Sage' },
  { hex: '#f1e4c8', name: 'Oat' },
  { hex: '#df7a5e', name: 'Terracotta' },
]
const SWATCH_GAP = 20

export const moodboard: BoardTemplate = {
  id: 'moodboard',
  name: 'Moodboard',
  description: 'Colors, tone and type, plus a column for images.',
  icon: Palette,
  color: 'pink',
  boardIcon: 'palette',
  build: layout((w) => {
    const sw = DEFAULT_SIZE.swatch
    const span = PALETTE.length * sw.w + (PALETTE.length - 1) * SWATCH_GAP
    const intro = w.note(
      { x: 0, y: 0 },
      [heading(1, 'Moodboard'), paragraph('Collect the colors, words and pictures that capture the feeling you are after.')],
      { w: 460 },
    )
    const paletteY = w.below(intro)
    PALETTE.forEach((s, i) => w.swatch({ x: i * (sw.w + SWATCH_GAP), y: paletteY }, s.hex, s.name))

    const notesY = paletteY + (sw.h ?? 160) + 40
    const half = (span - SWATCH_GAP) / 2
    w.note({ x: 0, y: notesY }, [heading(3, 'Tone'), bullets('Calm and warm', 'Honest, never loud', 'A little playful')], { w: half })
    w.note(
      { x: half + SWATCH_GAP, y: notesY },
      [
        heading(3, 'Typography'),
        paragraph({ text: 'Headings: ', bold: true }, 'a soft, friendly serif'),
        paragraph({ text: 'Body: ', bold: true }, 'a clean sans-serif'),
        paragraph('Plenty of white space.'),
      ],
      { w: half },
    )

    const inspiration = w.column({ x: span + 60, y: 0 }, 'Inspiration')
    w.note({ column: inspiration }, [heading(3, 'Drag images here'), paragraph('Drop pictures from your computer, or paste links to images and videos.')])
  }),
}

export const meetingNotes: BoardTemplate = {
  id: 'meeting-notes',
  name: 'Meeting notes',
  description: 'Agenda, notes, decisions and action items.',
  icon: NotebookPen,
  color: 'purple',
  boardIcon: 'notebook-pen',
  build: layout((w) => {
    const NOTES_W = 460
    w.note(
      { x: 0, y: 0 },
      [
        heading(1, 'Meeting notes'),
        paragraph({ text: 'When: ', bold: true }, 'add the date'),
        paragraph({ text: 'Who: ', bold: true }, 'add the names'),
        heading(2, 'Agenda'),
        numbered('Quick round of updates', 'The main topic', 'Questions and next steps'),
        heading(2, 'Notes'),
        bullets('Key points, as they come up', 'Questions that still need an answer'),
        heading(2, 'Decisions'),
        bullets('What we agreed on, and why'),
      ],
      { w: NOTES_W },
    )
    const sideX = NOTES_W + 40
    const actions = w.todo(
      { x: sideX, y: 0 },
      'Action items',
      tasks(
        { text: [{ text: '@Alex', bold: true }, ' send a short summary'] },
        { text: [{ text: '@Sam', bold: true }, ' book the next meeting'] },
        { text: [{ text: '@Jo', bold: true }, ' update the project plan'] },
      ),
      { color: 'purple' },
    )
    w.comment({ x: sideX, y: w.below(actions, 30) }, 'Questions or feedback? Leave a comment like this one, and reply to keep the conversation in one place.')
  }),
}

export const retrospective: BoardTemplate = {
  id: 'retrospective',
  name: 'Retrospective',
  description: 'Look back as a team and agree on next steps.',
  icon: RefreshCcw,
  color: 'orange',
  boardIcon: 'repeat',
  build: layout((w) => {
    const intro = w.note(
      { x: 0, y: 0 },
      [heading(1, 'Retrospective'), paragraph('Look back together: what worked, what didn’t, and what to try next time.')],
      { w: COL_W * 2 + GAP },
    )
    const y = w.below(intro)
    const x = (i: number) => i * (COL_W + GAP)
    const well = w.column({ x: x(0), y }, 'Went well', { color: 'green' })
    const improve = w.column({ x: x(1), y }, 'To improve', { color: 'orange' })
    const ideas = w.column({ x: x(2), y }, 'Ideas', { color: 'blue' })
    const actions = w.column({ x: x(3), y }, 'Action items', { color: 'purple' })

    w.note({ column: well }, [paragraph('Add a card for each thing that went well.')])
    w.note({ column: improve }, [paragraph('What slowed us down or got in the way?')])
    w.note({ column: ideas }, [paragraph('Something new to try next time.')])
    w.todo({ column: actions }, 'Next steps', tasks('Pick one or two things to change', 'Give each one an owner', 'Check back at the next retro'))
  }),
}

const FRAMES = [
  { title: 'Hook', caption: 'Grab attention in the first few seconds.' },
  { title: 'Setup', caption: 'Introduce who or what the story is about.' },
  { title: 'Problem', caption: 'Show what is getting in the way right now.' },
  { title: 'Turn', caption: 'The moment when things start to change.' },
  { title: 'Payoff', caption: 'Show the result, the fix or the answer.' },
  { title: 'Wrap-up', caption: 'End with one clear thing to do next.' },
]
const FRAME_W = 240
/** Wide enough for a clearly visible arrow between frames. */
const FRAME_GAP = 60

export const storyboard: BoardTemplate = {
  id: 'storyboard',
  name: 'Storyboard',
  description: 'Six numbered frames to plan a story or content.',
  icon: Clapperboard,
  color: 'red',
  boardIcon: 'clapperboard',
  build: layout((w) => {
    const intro = w.note(
      { x: 0, y: 0 },
      [heading(1, 'Storyboard'), paragraph('Plan a story, video or post one frame at a time. Swap any frame for a sketch or an image.')],
      { w: FRAME_W * 2 + FRAME_GAP },
    )
    const y = w.below(intro)
    const frames = FRAMES.map((f, i) =>
      w.note({ x: i * (FRAME_W + FRAME_GAP), y }, [heading(1, String(i + 1)), heading(3, f.title), paragraph(f.caption)], { w: FRAME_W }),
    )
    for (let i = 0; i + 1 < frames.length; i++) w.line(frames[i], frames[i + 1])
    const planY = Math.max(...frames.map((f) => w.below(f)))
    w.todo({ x: 0, y: planY }, 'Before publishing', tasks('Write the script', 'Gather images or footage', 'Pick a date to publish'))
  }),
}

export const BUILT_IN_TEMPLATES: readonly BoardTemplate[] = [
  projectPlan,
  weeklyPlanner,
  brainstorm,
  moodboard,
  meetingNotes,
  retrospective,
  storyboard,
]

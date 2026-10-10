// Reads and edits a todos.md in the format the /todo command writes, with a
// status in the checkbox and a description indented under the item:
//   ## Active     - [/] Title | Due: MM/DD/YYYY
//                   A description, one or more indented lines
//   ## Completed  - [x] Title | Done: MM/DD/YYYY   (newest first)
// The checkbox holds the status: [ ] open, [/] in progress, [>] waiting,
// [x] done, [-] dropped. Every edit touches only the item it changes, so
// notes and other headings in the file are kept as written.

import type { Status, Todo } from '../types'

export const TEMPLATE = '# Project Todos\n\n## Active\n\n## Completed\n'

export const STATUSES: readonly Status[] = ['todo', 'doing', 'waiting', 'done', 'dropped']

const MARKS: Record<Status, string> = { todo: ' ', doing: '/', waiting: '>', done: 'x', dropped: '-' }

const ITEM = /^[-*] \[(.)\] (.*)$/
const INDENTED = /^(?: {2,}|\t)\S/
const HEADING = /^#{1,6}\s/
const ACTIVE = /^##\s+active\b/i
const DONE = /^##\s+(completed|done)\b/i

type Located = Todo & { index: number; end: number }

export const isClosed = (status: Status) => status === 'done' || status === 'dropped'

const statusOf = (mark: string): Status => (mark === 'X' ? 'done' : (STATUSES.find(status => MARKS[status] === mark) ?? 'todo'))

const hash = (text: string) => {
  let value = 5381
  for (let i = 0; i < text.length; i++) {
    value = ((value << 5) + value + text.charCodeAt(i)) | 0
  }

  return (value >>> 0).toString(36)
}

const metaRe = (name: string) => new RegExp(`\\s*\\|\\s*${name}:\\s*([^|]*)`, 'i')

const meta = (body: string, name: string) => {
  const value = metaRe(name).exec(body)?.[1]?.trim()

  return value ? value : null
}

const strip = (body: string, name: string) => body.replace(metaRe(name), '').trim()

const cleanTitle = (title: string) => title.replace(/\s+/g, ' ').trim()

const cleanDescription = (description: string) =>
  description
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '')

const cleanDue = (due: string | null | undefined) => {
  const clean = (due ?? '').replace(/\|/g, ' ').trim()

  return clean === '' ? null : clean
}

const toLines = (source: string) => (source.trim() === '' ? TEMPLATE : source).replace(/\r\n/g, '\n').split('\n')

const toSource = (lines: string[]) => `${lines.join('\n').replace(/\n+$/, '')}\n`

// The end (exclusive) of the item at `index`: the indented lines under it,
// and the blank lines between them, are its description.
const blockEnd = (lines: string[], index: number) => {
  let end = index + 1
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    if (!INDENTED.test(line)) break
    end = i + 1
  }

  return end
}

const dedent = (lines: string[]) => {
  const indents = lines.filter(line => line.trim() !== '').map(line => /^\s*/.exec(line)![0].length)
  const cut = indents.length > 0 ? Math.min(...indents) : 0

  return lines.map(line => line.slice(cut).trimEnd()).join('\n')
}

// Ids come from the title (and which of several equal titles it is), so a
// change of status, due date or description keeps an item's id.
const locate = (lines: string[]): Located[] => {
  const seen = new Map<string, number>()
  const found: Located[] = []

  for (let index = 0; index < lines.length; index++) {
    const match = ITEM.exec(lines[index] ?? '')
    if (!match) continue

    const body = (match[2] ?? '').trim()
    const title = strip(strip(body, 'Due'), 'Done')
    const count = seen.get(title) ?? 0
    seen.set(title, count + 1)
    const end = blockEnd(lines, index)

    found.push({
      id: hash(`${title}#${count}`),
      index,
      end,
      status: statusOf(match[1] ?? ' '),
      title,
      description: dedent(lines.slice(index + 1, end)),
      due: meta(body, 'Due'),
      doneAt: meta(body, 'Done'),
    })
    index = end - 1
  }

  return found
}

const blockOf = (todo: Omit<Todo, 'id'>) => [
  `- [${MARKS[todo.status]}] ${todo.title}${todo.due ? ` | Due: ${todo.due}` : ''}${todo.doneAt ? ` | Done: ${todo.doneAt}` : ''}`,
  ...(todo.description === '' ? [] : todo.description.split('\n').map(line => (line === '' ? '' : `  ${line}`))),
]

const sectionEnd = (lines: string[], heading: number) => {
  let end = heading + 1
  while (end < lines.length && !HEADING.test(lines[end] ?? '')) end++

  return end
}

// The index of the section's heading, adding the heading when it is missing.
const ensure = (lines: string[], which: 'active' | 'done') => {
  const found = lines.findIndex(line => (which === 'active' ? ACTIVE : DONE).test(line))
  if (found >= 0) return found

  const heading = which === 'active' ? '## Active' : '## Completed'
  const done = which === 'active' ? lines.findIndex(line => DONE.test(line)) : -1
  if (done >= 0) {
    lines.splice(done, 0, heading, '')

    return done
  }

  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop()
  if (lines.length > 0) lines.push('')
  lines.push(heading)

  return lines.length - 1
}

// Keeps a blank line between an inserted item and a heading right after
// it; returns the item's index.
const insert = (lines: string[], at: number, block: string[]) => {
  lines.splice(at, 0, ...block)
  if (HEADING.test(lines[at + block.length] ?? '')) lines.splice(at + block.length, 0, '')

  return at
}

// Open items go last in Active, closed ones first in Completed.
const place = (lines: string[], status: Status, block: string[]) => {
  if (isClosed(status)) return insert(lines, ensure(lines, 'done') + 1, block)

  const heading = ensure(lines, 'active')
  let at = sectionEnd(lines, heading)
  while (at > heading + 1 && (lines[at - 1] ?? '').trim() === '') at--

  return insert(lines, at, block)
}

export const parse = (source: string): Todo[] => locate(toLines(source)).map(({ index, end, ...todo }) => todo)

export type Change = { source: string; todo: Todo }

export type Draft = { title: string; description?: string; status?: Status; due?: string | null }

export type Patch = Partial<Draft>

const find = (lines: string[], id: string) => locate(lines).find(todo => todo.id === id)

const changed = (lines: string[], index: number): Change => {
  const { index: _, end, ...todo } = locate(lines).find(one => one.index === index)!

  return { source: toSource(lines), todo }
}

export const add = (source: string, draft: Draft, date: string): Change | null => {
  const title = cleanTitle(draft.title)
  if (title === '') return null

  const status = draft.status ?? 'todo'
  const lines = toLines(source)
  const block = blockOf({
    status,
    title,
    description: cleanDescription(draft.description ?? ''),
    due: cleanDue(draft.due),
    doneAt: isClosed(status) ? date : null,
  })

  return changed(lines, place(lines, status, block))
}

// Changes what the patch names; an item that opens or closes moves to the
// other section, and one that stays keeps its place.
export const update = (source: string, id: string, patch: Patch, date: string): Change | null => {
  const lines = toLines(source)
  const todo = find(lines, id)
  if (!todo) return null

  const title = patch.title === undefined ? todo.title : cleanTitle(patch.title)
  if (title === '') return null

  const status = patch.status ?? todo.status
  const isMoving = isClosed(status) !== isClosed(todo.status)
  const block = blockOf({
    status,
    title,
    description: patch.description === undefined ? todo.description : cleanDescription(patch.description),
    due: patch.due === undefined ? todo.due : cleanDue(patch.due),
    doneAt: !isClosed(status) ? null : isMoving ? date : (todo.doneAt ?? date),
  })

  if (!isMoving) {
    lines.splice(todo.index, todo.end - todo.index, ...block)

    return changed(lines, todo.index)
  }

  lines.splice(todo.index, todo.end - todo.index)

  return changed(lines, place(lines, status, block))
}

export const remove = (source: string, id: string): Change | null => {
  const lines = toLines(source)
  const todo = find(lines, id)
  if (!todo) return null

  lines.splice(todo.index, todo.end - todo.index)
  const { index, end, ...removed } = todo

  return { source: toSource(lines), todo: removed }
}

const pad = (n: number) => String(n).padStart(2, '0')

export const formatDate = (ms: number) => {
  const date = new Date(ms)

  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`
}

// Dates as /todo writes them: MM/DD/YYYY, MM-DD-YYYY or YYYY-MM-DD, with
// anything after the date (a time) ignored.
const parseDate = (raw: string | null) => {
  if (!raw) return null

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw)
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))

  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(raw)
  if (us) return new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]))

  return null
}

export const isOverdue = (due: string | null, nowMs: number) => {
  const date = parseDate(due)
  if (!date) return false

  const now = new Date(nowMs)

  return date.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// A short date (Oct 9), the year only when it is not this year's
// (Jan 15, 2020); a date it cannot read is shown as written.
export const showDate = (raw: string | null, nowMs: number) => {
  const date = parseDate(raw)
  if (!date) return raw ?? ''

  const year = date.getFullYear() === new Date(nowMs).getFullYear() ? '' : `, ${date.getFullYear()}`

  return `${MONTHS[date.getMonth()]} ${date.getDate()}${year}`
}

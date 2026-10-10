import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Status, Todo, TodoFile } from '../types'
import * as todos from './todos'

const PANE = 'todos'
const FILE_NAME = 'todos.md'
const POLL_MS = 2000
const DONE_SHOWN = 30

const list = atom({ plugin: 'todo-sidebar', key: 'list' } as const, null)
const showDone = atom({ plugin: 'todo-sidebar', key: 'showDone' } as const, false)
const armed = atom({ plugin: 'todo-sidebar', key: 'armed' } as const, null)
const formKey = atom({ plugin: 'todo-sidebar', key: 'formKey' } as const, 0)
const selected = atom({ plugin: 'todo-sidebar', key: 'selected' } as const, null)
const isEditingNotes = atom({ plugin: 'todo-sidebar', key: 'isEditingNotes' } as const, false)
const isEditingTitle = atom({ plugin: 'todo-sidebar', key: 'isEditingTitle' } as const, false)
const statusMenu = atom({ plugin: 'todo-sidebar', key: 'statusMenu' } as const, null)
const hasEditorFault = atom({ plugin: 'todo-sidebar', key: 'hasEditorFault' } as const, false)
const collapsed = atom({ plugin: 'todo-sidebar', key: 'collapsed' } as const, [])

const STATUS: Record<Status, { label: string; glyph: string; color?: string }> = {
  todo: { label: 'Open', glyph: '○' },
  doing: { label: 'In progress', glyph: '◐', color: 'suggestion' },
  waiting: { label: 'Waiting', glyph: '◷', color: 'warning' },
  done: { label: 'Done', glyph: '✓', color: 'success' },
  dropped: { label: 'Dropped', glyph: '✕', color: 'inactive' },
}

// The open statuses in the order the list groups them.
const GROUPS: Status[] = ['doing', 'todo', 'waiting']

// The moves an open item's page offers as buttons, the likeliest first (drawn
// as the primary one); the Status picker has the rest.
const NEXT: Record<Status, { status: Status; label: string }[]> = {
  todo: [
    { status: 'doing', label: '▶ Start' },
    { status: 'done', label: '✓ Mark done' },
  ],
  doing: [
    { status: 'done', label: '✓ Mark done' },
    { status: 'waiting', label: '◷ Waiting' },
  ],
  waiting: [
    { status: 'doing', label: '▶ Resume' },
    { status: 'done', label: '✓ Mark done' },
  ],
  done: [{ status: 'todo', label: '↺ Reopen' }],
  dropped: [{ status: 'todo', label: '↺ Reopen' }],
}

// Each status's color as a raw color, for the surfaces other than the
// terminal (which takes STATUS's theme keys): readable on dark and light
// themes, and what an Svg image needs. An open item has none.
const HEX: Record<Status, string | null> = {
  todo: null,
  doing: '#58a6ff',
  waiting: '#d29922',
  done: '#3fb950',
  dropped: '#8b949e',
}

// An overdue date, the progress bar's empty track, and a row's background
// under the pointer.
const LATE = '#f85149'
const TRACK = '#8b949e33'
const ROW_HOVER = '#8b949e1f'

// A session in a desktop worktree (<project>/.claude/worktrees/<name>) shares
// the project's own list, since todos.md is usually git-ignored.
const projectRoot = (root: string) => root.replace(/\/\.claude\/worktrees\/[^/]+\/?$/, '')

const todoPath = async ($: EngineInterface) => `${projectRoot(await $.session.root())}/${FILE_NAME}`

const projectName = (path: string) => path.split('/').slice(-2, -1)[0] ?? ''

const refresh = async ($: EngineInterface, force = false) => {
  const path = await todoPath($)
  const held = await read($, list)
  const stat = await $.fs.stat(path).catch(() => null)
  const mtimeMs = stat?.mtimeMs ?? 0
  if (!force && held?.path === path && held.mtimeMs === mtimeMs && held.error === null) return held

  let next: TodoFile
  try {
    const source = stat ? await $.fs.read(path) : ''
    next = { path, mtimeMs, items: stat ? todos.parse(source) : [], error: null }
  } catch (error) {
    next = { path, mtimeMs, items: held?.items ?? [], error: `Could not read ${FILE_NAME}: ${String(error)}` }
  }
  await update($, list, () => next)

  return next
}

// Reads the file fresh, applies the edit and writes it back, so an edit made
// meanwhile by /todo or the model is never overwritten.
const mutate = async ($: EngineInterface, edit: (source: string) => todos.Change | null) => {
  const path = await todoPath($)
  const source = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  const change = edit(source)
  if (change && change.source !== source) {
    await $.fs.write(path, change.source)
    await refresh($, true)
  }

  return change
}

const today = async ($: EngineInterface) => todos.formatDate(await $.clock.now())

// What the person has typed into the open item's fields and not saved yet,
// by field: `title` and `description` from the editor (editor.tsx), or,
// where a surface has none, `note-<i>` and `note-new` from one Input per
// line. Any Enter, a pick of status and the way back save all of it.
const drafts = new Map<string, string>()

const SAVE_AFTER_MS = 700

// The pending save of what the editor holds, restarted by each change.
let autosave: { cancel: () => void } | null = null

const patchFrom = (todo: Todo, patch: todos.Patch): todos.Patch => {
  const title = drafts.get('title')
  const lines = todo.description === '' ? [] : todo.description.split('\n')
  const kept = lines.flatMap((line, i) => {
    const draft = drafts.get(`note-${i}`)

    return draft === undefined ? [line] : draft.trim() === '' ? [] : [draft]
  })
  const added = drafts.get('note-new') ?? ''
  const description = drafts.get('description') ?? [...kept, ...(added.trim() === '' ? [] : [added])].join('\n')

  return {
    ...(title !== undefined && title.trim() !== '' ? { title } : {}),
    ...(description !== todo.description ? { description } : {}),
    ...patch,
  }
}

// Saves the drafts (and `patch`) to the item; resolves to the new form key.
// A draft that changed while the file was written stays for the next save.
const save = async ($: EngineInterface, id: string, patch: todos.Patch = {}) => {
  autosave?.cancel()
  autosave = null
  const used = new Map(drafts)
  const date = await today($)
  const change = await mutate($, source => {
    const todo = todos.parse(source).find(one => one.id === id)

    return todo ? todos.update(source, id, patchFrom(todo, patch), date) : null
  })
  used.forEach((value, field) => drafts.get(field) === value && drafts.delete(field))
  if (change) await update($, selected, () => change.todo.id)

  return update($, formKey, key => key + 1)
}

const openItem = async ($: EngineInterface, id: string | null) => {
  autosave?.cancel()
  autosave = null
  drafts.clear()
  await update($, armed, () => null)
  await update($, isEditingNotes, () => false)
  await update($, isEditingTitle, () => false)
  await update($, statusMenu, () => null)
  await update($, selected, () => id)
}

const setStatus = async ($: EngineInterface, id: string, status: Status) => {
  const date = await today($)
  await update($, statusMenu, () => null)
  await mutate($, source => todos.update(source, id, { status }, date))
}

// A title drawn as a markdown heading reads as written: its markdown
// characters are escaped.
const asHeading = (title: string) => `## ${title.replace(/([\\`*_[\]<>#|~])/g, '\\$1')}`

const focus = ($: EngineInterface, key: string) => void $.ui.focus({ requestId: PANE, key }).catch(() => undefined)

// One line of the file is one line in the pane: markdown would run lines
// that follow each other together into one paragraph.
const asMarkdown = (description: string) =>
  description
    .split('\n')
    .map((line, i, all) => (line.trim() !== '' && (all[i + 1] ?? '').trim() !== '' ? `${line}  ` : line))
    .join('\n')

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Todo', columns: 46 })

const describe = (todo: Todo, n: number) => {
  const dates = `${todo.due ? ` (due ${todo.due})` : ''}${todo.doneAt ? ` (${todo.status} ${todo.doneAt})` : ''}`
  const head = `${n}. [${todo.status}] ${todo.title}${dates} {id: ${todo.id}}`

  return todo.description === '' ? head : [head, ...todo.description.split('\n').map(line => `     ${line}`)].join('\n')
}

const listText = (held: TodoFile) => {
  const active = held.items.filter(todo => !todos.isClosed(todo.status))
  const closed = held.items.filter(todo => todos.isClosed(todo.status))
  const lines = [`${held.path}`, '', `Open (${active.length}):`, ...active.map((todo, i) => describe(todo, i + 1))]
  if (closed.length > 0) lines.push('', `Closed (${closed.length}, newest first):`, ...closed.slice(0, 20).map((todo, i) => describe(todo, i + 1)))

  return lines.join('\n')
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

const TOOL = 'mcp__todo-sidebar__todo'

// The last tree drawn on each surface and what it was drawn from. The engine
// draws the pane again when it gains or loses the keyboard, which a click on
// a Button does; handing back the same tree keeps the elements the surface
// has, so that click still lands on its Button.
const drawings = new Map<string, { inputs: string; tree: RenderElement }>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todo-sidebar',
      description: "Open the project's todo list in the sidebar",
    })
    await $.tool.register({
      name: 'todo',
      description:
        "Read or change this project's todo list (todos.md in the project root, shown to the user in a sidebar). " +
        'Each item has a short title, an optional description (markdown, may span lines) and a status: ' +
        'todo, doing (in progress), waiting, done or dropped. ' +
        "action 'list' shows the items with their ids; 'add' needs a title; 'update' needs the id and changes only what you pass; 'remove' needs the id. " +
        'Keep titles short and put details, links and steps in the description. ' +
        'Use it when the user asks to note, start, finish or review project todos, or when you start or finish work that is on the list.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'update', 'remove'] },
          id: { type: 'string', description: "The item's id from 'list', for 'update' and 'remove'." },
          title: { type: 'string', description: 'A short title, one line.' },
          description: {
            type: 'string',
            description: "Details in markdown, may span several lines. An empty string clears it on 'update'.",
          },
          status: { type: 'string', enum: [...todos.STATUSES] },
          due: { type: 'string', description: "A due date, MM/DD/YYYY. An empty string clears it on 'update'." },
        },
        required: ['action'],
      },
    })

    await refresh($, true)
    $.clock.every(POLL_MS, () => void refresh($))
    void openPane($)

    return next(e)
  })

  on('command.run', { command: 'todo-sidebar' }, async $ => {
    await refresh($, true)
    const opened = await openPane($)

    return { text: opened.isPlaced ? 'The todo list is open in the sidebar.' : 'The todo list opens when there is room for it.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const action = String(e.action ?? 'list')
    const id = str(e.id)?.trim() ?? ''
    const status = todos.STATUSES.find(one => one === e.status)
    if (e.status !== undefined && !status) {
      return { deny: `Unknown status "${String(e.status)}"; use one of ${todos.STATUSES.join(', ')}.` }
    }

    const fields: todos.Patch = { title: str(e.title), description: str(e.description), status, due: str(e.due) }
    const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as todos.Patch
    const date = await today($)

    const edits: Record<string, (source: string) => todos.Change | null> = {
      add: source => todos.add(source, { ...patch, title: patch.title ?? '' }, date),
      update: source => todos.update(source, id, patch, date),
      remove: source => todos.remove(source, id),
    }
    const edit = edits[action]
    if (action !== 'list' && !edit) return { deny: `Unknown action "${action}".` }

    const change = edit ? await mutate($, edit) : null
    const held = await refresh($, true)
    if (edit && !change) {
      const why = action === 'add' ? 'the title is empty' : `no item has id "${id}"${action === 'update' ? ', or the title is empty' : ''}`

      return { deny: `Nothing changed: ${why}.\n\n${listText(held)}` }
    }

    const done = change ? `${action}: ${change.todo.title} [${change.todo.status}]\n\n` : ''

    return { result: `${done}${listText(held)}` }
  }).catch(() => ({ deny: 'todo-sidebar: could not read or write todos.md.' }))

  // What the editor posts: each change of its text, autosaved for the
  // description, and a submit that saves the field and closes it.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { kind?: unknown; text?: unknown } | null
    const field = e.element.startsWith('title-') ? 'title' : e.element.startsWith('notes-') ? 'description' : null
    if (e.requestId !== PANE || !field || typeof data?.text !== 'string') return next(e)

    const id = e.element.slice(e.element.indexOf('-') + 1)
    drafts.set(field, data.text)
    if (data.kind === 'submit') {
      await save($, id)
      if (field === 'title') await update($, isEditingTitle, () => false)
      else await update($, isEditingNotes, () => false)
    } else if (field === 'description') {
      autosave?.cancel()
      autosave = $.clock.after(SAVE_AFTER_MS, () => void save($, id))
    }

    return {}
  })

  // Where the editor cannot run, the pane goes back to the surface's own fields.
  on('ui.fault', async ($, e, next) => {
    if (e.requestId === PANE) await update($, hasEditorFault, () => true)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = elements
    const Input = 'Input' in elements ? elements.Input : null
    const Select = 'Select' in elements ? elements.Select : null
    const Client = 'Client' in elements && !(await read($, hasEditorFault)) ? elements.Client : null
    // A terminal that draws no images (Terminal.app) leaves an Svg blank, so
    // the terminal always gets the bar in text.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null

    const held = await read($, list)
    const openId = await read($, selected)
    const isShowingDone = await read($, showDone)
    const armedId = await read($, armed)
    const isEditing = await read($, isEditingNotes)
    const isRenaming = await read($, isEditingTitle)
    const menuId = await read($, statusMenu)
    const shut = await read($, collapsed)
    const gen = await read($, formKey)
    const now = await $.clock.now()

    const items = held?.items ?? []
    const active = items.filter(todo => !todos.isClosed(todo.status))
    const closed = items.filter(todo => todos.isClosed(todo.status))
    const name = held ? projectName(held.path) : 'Todo'

    const glyph = (status: Status) => {
      const { glyph: mark, color } = STATUS[status]

      return color ? <Text color={color}>{mark}</Text> : <Text>{mark}</Text>
    }

    // A status's color on this surface; a desktop draws no color inside a
    // Button, so it goes on what stands beside one: a dot, a border.
    const tone = (status: Status) => (e.surface === 'terminal' ? STATUS[status].color : HEX[status])
    const late = e.surface === 'terminal' ? 'error' : LATE
    const dot = (status: Status) => {
      const color = tone(status)

      return color ? <Text color={color}>●</Text> : <Text dimColor>●</Text>
    }
    const border = (status: Status) => {
      const color = tone(status)

      return !color ? { borderDimColor: true } : e.surface === 'terminal' ? { borderColor: color, borderDimColor: true } : { borderColor: `${color}59` }
    }

    const rowHover = e.surface === 'terminal' ? {} : { hover: { backgroundColor: ROW_HOVER } }

    const row = (todo: Todo) => {
      const isDone = todos.isClosed(todo.status)
      const date = isDone ? todo.doneAt : todo.due
      const isLate = !isDone && todos.isOverdue(todo.due, now)
      const meta = [
        ...(todo.description !== '' ? [<Text dimColor>≡</Text>] : []),
        ...(date ? [isLate ? <Text color={late}>{todos.showDate(date, now)}</Text> : <Text dimColor>{todos.showDate(date, now)}</Text>] : []),
      ]

      // A desktop draws a Button's `label` in place of its children, so the
      // glyph Button has none.
      return (
        <Box flexDirection="column">
          <Box key={`row-${todo.id}`} flexDirection="row" gap={1} {...rowHover}>
            <Box flexShrink={0}>
              <Button
                key={`status-${todo.id}`}
                plain
                onPress={() => void update($, statusMenu, open => (open === todo.id ? null : todo.id))}
              >
                {glyph(todo.status)}
              </Button>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Button key={`open-${todo.id}`} plain onPress={() => void openItem($, todo.id)}>
                <Text wrap="truncate-end" strikethrough={isDone} dimColor={isDone}>
                  {todo.title}
                </Text>
              </Button>
            </Box>
            {meta.length > 0 ? (
              <Box flexShrink={0} flexDirection="row" gap={1}>
                {meta}
              </Box>
            ) : null}
          </Box>
          {menuId === todo.id ? statusPicker(todo) : null}
        </Box>
      )
    }

    // The statuses to pick from, opened under a row by its glyph.
    const statusPicker = (todo: Todo) => (
      <Box flexDirection="column" alignSelf="flex-start" borderStyle="round" borderDimColor paddingX={1}>
        {todos.STATUSES.map(status => (
          <Button key={`set-${todo.id}-${status}`} plain onPress={() => void setStatus($, todo.id, status)}>
            {glyph(status)}
            {status === todo.status ? <Text bold> {STATUS[status].label}</Text> : <Text> {STATUS[status].label}</Text>}
          </Button>
        ))}
      </Box>
    )

    const addTodo = async (value: string) => {
      const date = await today($)
      const change = await mutate($, source => todos.add(source, { title: value }, date))
      if (!change) return
      focus($, `new-${await update($, formKey, key => key + 1)}`)
    }

    // How far the list has come: closed, in progress and waiting items as
    // shares of all, a thin Svg bar where the surface draws one.
    const progress = () => {
      const counts = [closed.length, active.filter(todo => todo.status === 'doing').length, active.filter(todo => todo.status === 'waiting').length]
      if (Svg) {
        const [width, height] = [1000, 8]
        let x = 0
        const parts = counts.map((count, i) => {
          const part = Math.round((width * count) / items.length)
          const rect = `<rect x="${x}" width="${part}" height="${height}" fill="${[HEX.done, HEX.doing, HEX.waiting][i]}"/>`
          x += part

          return rect
        })
        const source =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
          `<clipPath id="bar"><rect width="${width}" height="${height}" rx="${height / 2}"/></clipPath>` +
          `<g clip-path="url(#bar)"><rect width="${width}" height="${height}" fill="${TRACK}"/>${parts.join('')}</g></svg>`

        return <Svg source={source} alt={`${closed.length} of ${items.length} done`} />
      }

      const width = Math.max(10, Math.min(40, e.props.bodyColumns - 2))
      const [done, doing, waiting] = counts.map(count => Math.round((width * count) / items.length))

      return (
        <Text>
          <Text color="success">{'━'.repeat(done ?? 0)}</Text>
          <Text color="suggestion">{'━'.repeat(doing ?? 0)}</Text>
          <Text color="warning">{'━'.repeat(waiting ?? 0)}</Text>
          <Text dimColor>{'━'.repeat(Math.max(0, width - (done ?? 0) - (doing ?? 0) - (waiting ?? 0)))}</Text>
        </Text>
      )
    }

    // A group of rows: its heading, which folds them away, over a card in
    // the status's color.
    const group = (key: string, status: Status, label: string, count: number, isOpen: boolean, onToggle: () => void, rows: RenderElement[]) => (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            {dot(status)}
            <Button key={key} plain onPress={onToggle}>
              {label}
            </Button>
          </Box>
          <Box flexDirection="row" gap={2}>
            <Text dimColor>{count}</Text>
            <Button key={`${key}-fold`} plain dimColor onPress={onToggle}>
              {isOpen ? '▾' : '▸'}
            </Button>
          </Box>
        </Box>
        {isOpen ? (
          <Box flexDirection="column" borderStyle="round" {...border(status)} paddingX={1}>
            {rows}
          </Box>
        ) : null}
      </Box>
    )

    const listView = () => {
      const groups = GROUPS.map(status => ({ status, items: active.filter(todo => todo.status === status) })).filter(
        group => group.items.length > 0,
      )
      const toggleGroup = (status: Status) =>
        void update($, collapsed, shut => (shut.includes(status) ? shut.filter(one => one !== status) : [...shut, status]))

      return (
        <Box flexDirection="column" gap={2}>
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{name}</Text>
              {items.length > 0 ? (
                <Text dimColor>
                  {closed.length} of {items.length} done
                </Text>
              ) : null}
            </Box>
            {items.length > 0 ? progress() : null}
          </Box>

          {Input || held?.error ? (
            <Box flexDirection="column">
              {Input ? <Input key={`new-${gen}`} placeholder="New task …" value="" submitLabel="add" onSubmit={value => void addTodo(value)} /> : null}
              {held?.error ? <Text color={late}>{held.error}</Text> : null}
            </Box>
          ) : null}

          <Box flexDirection="column" gap={2}>
            {active.length === 0 ? (
              <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
                <Text>Nothing open ✨</Text>
                <Text dimColor>Add a task above, or ask Claude to put one on the list.</Text>
              </Box>
            ) : null}
            {groups.map(({ status, items: rows }) =>
              group(`group-${status}`, status, STATUS[status].label, rows.length, !shut.includes(status), () => toggleGroup(status), rows.map(row)),
            )}
            {closed.length > 0
              ? group('toggle-done', 'done', 'Completed', closed.length, isShowingDone, () => void update($, showDone, shown => !shown), [
                  ...closed.slice(0, DONE_SHOWN).map(row),
                  ...(closed.length > DONE_SHOWN ? [<Text dimColor>… and {closed.length - DONE_SHOWN} older in {FILE_NAME}</Text>] : []),
                ])
              : null}
          </Box>
        </Box>
      )
    }

    const detailView = (todo: Todo) => {
      const lines = todo.description === '' ? [] : todo.description.split('\n')
      const keep = (field: string) => (value: string) => void drafts.set(field, value)
      const saveWith = (field: string) => (value: string) => {
        drafts.set(field, value)
        void save($, todo.id)
      }
      const addNote = async (value: string) => {
        drafts.set('note-new', value)
        focus($, `note-new-${await save($, todo.id)}`)
      }
      const editNotes = async (isOn: boolean) => {
        if (!isOn && drafts.size > 0) await save($, todo.id)
        await update($, isEditingNotes, () => isOn)
        if (isOn) focus($, Client ? `notes-${todo.id}` : `note-new-${gen}`)
      }
      const editTitle = async () => {
        await update($, isEditingTitle, () => true)
        focus($, Client ? `title-${todo.id}` : `title-input-${gen}`)
      }
      const rename = async (value: string) => {
        drafts.set('title', value)
        await save($, todo.id)
        await update($, isEditingTitle, () => false)
      }
      const cancelRename = async () => {
        drafts.delete('title')
        await update($, isEditingTitle, () => false)
      }
      const back = async () => {
        if (drafts.size > 0) await save($, todo.id)
        await openItem($, null)
      }
      const remove = async () => {
        await mutate($, source => todos.remove(source, todo.id))
        await openItem($, null)
      }
      // One line of the properties card: a dim label, then its value.
      const property = (label: string, value: RenderElement) => (
        <Box flexDirection="row" gap={2} alignItems="center">
          <Box width={8} flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {value}
          </Box>
        </Box>
      )
      const properties = [
        property(
          'Status',
          Select ? (
            <Select
              key={`status-${gen}`}
              value={todo.status}
              options={todos.STATUSES.map(status => ({ value: status, label: `${STATUS[status].glyph}  ${STATUS[status].label}` }))}
              onSelect={value => void save($, todo.id, { status: value as Status })}
            />
          ) : (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {todos.STATUSES.map(status => (
                <Button key={`status-${status}`} plain dimColor={status !== todo.status} onPress={() => void save($, todo.id, { status })}>
                  {glyph(status)} {STATUS[status].label}
                </Button>
              ))}
            </Box>
          ),
        ),
        ...(todo.due && !todos.isClosed(todo.status)
          ? [property('Due', <Text color={todos.isOverdue(todo.due, now) ? late : 'text'}>{todos.showDate(todo.due, now)}</Text>)]
          : []),
        ...(todo.doneAt && todos.isClosed(todo.status) ? [property(STATUS[todo.status].label, <Text>{todos.showDate(todo.doneAt, now)}</Text>)] : []),
      ]

      const date = todos.isClosed(todo.status) ? todo.doneAt : todo.due
      const isLate = !todos.isClosed(todo.status) && todos.isOverdue(todo.due, now)
      const subtitle = date ? (
        isLate ? (
          <Text color={late}>· overdue since {todos.showDate(date, now)}</Text>
        ) : (
          <Text dimColor>
            · {todos.isClosed(todo.status) ? '' : 'due '}
            {todos.showDate(date, now)}
          </Text>
        )
      ) : null

      // A section's heading, as the list draws a group's: a dot in the
      // status's color, a bold label, and on the right what acts on it.
      const heading = (label: string, action: RenderElement | null = null) => (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            {dot(todo.status)}
            <Text bold>{label}</Text>
          </Box>
          {action}
        </Box>
      )

      const isEditable = Client !== null || Input !== null
      const moves = NEXT[todo.status]

      return (
        <Box flexDirection="column" gap={2}>
          <Box flexDirection="row">
            <Button key="back" variant="secondary" label={`‹ ${name}`} onPress={() => void back()} />
          </Box>

          {isRenaming && Client ? (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="column" borderStyle="round" {...border(todo.status)} paddingX={1}>
                <Client
                  key={`title-${todo.id}`}
                  module="./editor.tsx"
                  props={{ text: todo.title, placeholder: 'Title', isMultiline: false, rows: 1, isBold: true }}
                  width="100%"
                />
              </Box>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Button key="save-title" variant="primary" label="Save" onPress={() => void rename(drafts.get('title') ?? todo.title)} />
                <Button key="cancel-title" variant="secondary" label="Cancel" onPress={() => void cancelRename()} />
                <Text dimColor>Enter saves</Text>
              </Box>
            </Box>
          ) : isRenaming && Input ? (
            <Box flexDirection="column" gap={1}>
              <Input
                key={`title-input-${gen}`}
                value={todo.title}
                submitLabel="save"
                autoFocus
                onInput={keep('title')}
                onSubmit={value => void rename(value)}
              />
              <Box flexDirection="row">
                <Button key="cancel-title" variant="secondary" label="Cancel" onPress={() => void cancelRename()} />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="column">
                <Box flexDirection="row" gap={2} alignItems="flex-start">
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Markdown text={asHeading(todo.title)} />
                  </Box>
                  {isEditable ? (
                    <Box flexShrink={0}>
                      <Button key="edit-title" variant="secondary" label="✎ Rename" onPress={() => void editTitle()} />
                    </Box>
                  ) : null}
                </Box>
                <Box flexDirection="row" gap={1}>
                  {dot(todo.status)}
                  {tone(todo.status) ? <Text color={tone(todo.status)!}>{STATUS[todo.status].label}</Text> : <Text>{STATUS[todo.status].label}</Text>}
                  {subtitle}
                </Box>
              </Box>
              <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
                {moves.map((move, i) => (
                  <Button
                    key={`move-${move.status}`}
                    variant={i === 0 ? 'primary' : 'secondary'}
                    label={move.label}
                    onPress={() => void save($, todo.id, { status: move.status })}
                  />
                ))}
              </Box>
            </Box>
          )}

          <Box flexDirection="column" gap={1}>
            {heading('Details')}
            <Box flexDirection="column" gap={1} borderStyle="round" {...border(todo.status)} paddingX={1} paddingY={e.surface === 'terminal' ? 0 : 1}>
              {properties}
            </Box>
          </Box>

          <Box flexDirection="column" gap={1}>
            {heading(
              'Description',
              isEditable && (isEditing || lines.length > 0) ? (
                <Button
                  key="edit-notes"
                  variant={isEditing ? 'primary' : 'secondary'}
                  label={isEditing ? '✓ Done' : '✎ Edit'}
                  onPress={() => void editNotes(!isEditing)}
                />
              ) : null,
            )}
            {isEditing && Client ? (
              <Box flexDirection="column">
                <Client
                  key={`notes-${todo.id}`}
                  module="./editor.tsx"
                  props={{ text: todo.description, placeholder: 'Write a description …', isMultiline: true, rows: 8, isBold: false }}
                  width="100%"
                />
                <Text dimColor>Click in the field to type · saved as you type · ⌘↩ closes</Text>
              </Box>
            ) : isEditing && Input ? (
              <Box flexDirection="column">
                {lines.map((line, i) => (
                  <Input
                    key={`note-${i}-${gen}`}
                    value={line}
                    placeholder="Empty line (Enter removes it)"
                    submitLabel="save"
                    onInput={keep(`note-${i}`)}
                    onSubmit={saveWith(`note-${i}`)}
                  />
                ))}
                <Input
                  key={`note-new-${gen}`}
                  value=""
                  placeholder="New line …"
                  submitLabel="add"
                  autoFocus
                  onInput={keep('note-new')}
                  onSubmit={value => void addNote(value)}
                />
              </Box>
            ) : lines.length > 0 ? (
              <Box borderStyle="round" borderDimColor paddingX={1}>
                <Markdown text={asMarkdown(todo.description)} />
              </Box>
            ) : isEditable ? (
              <Box flexDirection="column" alignItems="flex-start" gap={1} borderStyle="dashed" borderDimColor paddingX={1} paddingY={e.surface === 'terminal' ? 0 : 1}>
                <Text dimColor>No description yet. Add steps, links or notes.</Text>
                <Button key="add-notes" variant="secondary" label="＋ Add a description" onPress={() => void editNotes(true)} />
              </Box>
            ) : (
              <Text dimColor>No description.</Text>
            )}
          </Box>

          {armedId === todo.id ? (
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={late} paddingX={1} paddingY={e.surface === 'terminal' ? 0 : 1}>
              <Text bold>Delete this task?</Text>
              <Text dimColor>It is removed from {FILE_NAME}. This can't be undone here.</Text>
              <Box flexDirection="row" gap={1}>
                <Button key={`remove-${todo.id}`} variant="primary" label="🗑 Delete" onPress={() => void remove()} />
                <Button key={`keep-${todo.id}`} variant="secondary" label="Keep" onPress={() => void update($, armed, () => null)} />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="row">
              <Button key={`arm-${todo.id}`} variant="secondary" label="🗑 Delete task" onPress={() => void update($, armed, () => todo.id)} />
            </Box>
          )}
        </Box>
      )
    }

    const open = openId ? items.find(todo => todo.id === openId) : undefined
    const inputs = JSON.stringify([held, openId, isShowingDone, armedId, isEditing, isRenaming, menuId, shut, gen, Client !== null, todos.formatDate(now), e.props.bodyColumns])
    const last = drawings.get(e.surface)
    if (last?.inputs === inputs) return last.tree

    const tree = open ? detailView(open) : listView()
    drawings.set(e.surface, { inputs, tree })

    return tree
  })
}

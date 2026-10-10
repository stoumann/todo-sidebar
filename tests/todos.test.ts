import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import * as todos from '../hooks/todos'

const SAMPLE = `# Project Todos

## Active
- [ ] Ship to production
- [/] Turn on Google login | Due: 01/15/2020
  Google Cloud: OAuth client with a redirect.

  Then set NUXT_PUBLIC_LOGIN_PROVIDERS=google in Vercel.
- [>] Check the marketing rules

## Completed
- [x] Import the holiday events | Done: 10/09/2026
- [-] Try MobilePay | Done: 10/08/2026
`

const DATE = '10/10/2026'

const byTitle = (source: string, title: string) => todos.parse(source).find(todo => todo.title === title)!

describe('todos.md', () => {
  test('parses statuses, dates and indented descriptions', () => {
    const items = todos.parse(SAMPLE)
    expect(items.map(todo => [todo.status, todo.title])).toEqual([
      ['todo', 'Ship to production'],
      ['doing', 'Turn on Google login'],
      ['waiting', 'Check the marketing rules'],
      ['done', 'Import the holiday events'],
      ['dropped', 'Try MobilePay'],
    ])
    expect(items[1]?.due).toBe('01/15/2020')
    expect(items[1]?.description).toBe('Google Cloud: OAuth client with a redirect.\n\nThen set NUXT_PUBLIC_LOGIN_PROVIDERS=google in Vercel.')
    expect(items[0]?.description).toBe('')
    expect(items[3]?.doneAt).toBe('10/09/2026')
  })

  test('reads the plain [ ] and [x] items /todo writes', () => {
    const items = todos.parse('## Active\n- [ ] One\n\n## Completed\n- [X] Two | Done: 10/09/2026\n')
    expect(items.map(todo => todo.status)).toEqual(['todo', 'done'])
  })

  test('adds a title and a description to the end of Active', () => {
    const change = todos.add(SAMPLE, { title: '  New   task ', description: 'First line\nSecond line\n' }, DATE)!
    expect(change.todo).toMatchObject({ title: 'New task', status: 'todo', description: 'First line\nSecond line' })
    expect(change.source).toContain('- [>] Check the marketing rules\n- [ ] New task\n  First line\n  Second line\n\n## Completed')
  })

  test('changes status in place and keeps the id', () => {
    const before = byTitle(SAMPLE, 'Ship to production')
    const change = todos.update(SAMPLE, before.id, { status: 'doing' }, DATE)!
    expect(change.todo.id).toBe(before.id)
    expect(change.source).toContain('## Active\n- [/] Ship to production\n- [/] Turn on Google')
  })

  test('closing moves the item and its description to the top of Completed', () => {
    const id = byTitle(SAMPLE, 'Turn on Google login').id
    const change = todos.update(SAMPLE, id, { status: 'done' }, DATE)!
    expect(change.source).toContain(
      '## Completed\n- [x] Turn on Google login | Due: 01/15/2020 | Done: 10/10/2026\n  Google Cloud: OAuth client with a redirect.\n\n  Then set',
    )
    expect(change.source).toContain('## Active\n- [ ] Ship to production\n- [>] Check the marketing rules\n\n## Completed')
  })

  test('reopening moves it to the end of Active without the done date', () => {
    const id = byTitle(SAMPLE, 'Import the holiday events').id
    const change = todos.update(SAMPLE, id, { status: 'waiting' }, DATE)!
    expect(change.source).toContain('- [>] Check the marketing rules\n- [>] Import the holiday events\n\n## Completed\n- [-] Try')
  })

  test('done and dropped swap in place and keep the date', () => {
    const id = byTitle(SAMPLE, 'Try MobilePay').id
    expect(todos.update(SAMPLE, id, { status: 'done' }, DATE)!.source).toContain('- [x] Try MobilePay | Done: 10/08/2026')
  })

  test('edits the title and description and refuses an empty title', () => {
    const id = byTitle(SAMPLE, 'Turn on Google login').id
    const change = todos.update(SAMPLE, id, { title: 'Google-login', description: 'Just one line' }, DATE)!
    expect(change.todo.id).not.toBe(id)
    expect(change.source).toContain('- [/] Google-login | Due: 01/15/2020\n  Just one line\n- [>] Check')
    expect(todos.update(SAMPLE, id, { description: '' }, DATE)!.source).toContain('| Due: 01/15/2020\n- [>] Check')
    expect(todos.update(SAMPLE, id, { title: '  ' }, DATE)).toBeNull()
  })

  test('removes the item with its description and leaves the rest as written', () => {
    const withNote = SAMPLE.replace('## Active', 'Notes to self.\n\n## Active')
    const change = todos.remove(withNote, byTitle(withNote, 'Turn on Google login').id)!
    expect(change.source).toContain('Notes to self.')
    expect(change.source).toContain('- [ ] Ship to production\n- [>] Check')
    expect(todos.parse(change.source)).toHaveLength(4)
  })

  test('creates the file structure from nothing', () => {
    expect(todos.add('', { title: 'First' }, DATE)!.source).toBe('# Project Todos\n\n## Active\n- [ ] First\n\n## Completed\n')
  })

  test('tells two identical titles apart', () => {
    const twice = '## Active\n- [ ] Same\n- [ ] Same\n'
    const [first, second] = todos.parse(twice)
    expect(first?.id).not.toBe(second?.id)
    expect(todos.parse(todos.remove(twice, second!.id)!.source)).toHaveLength(1)
  })

  test('knows an overdue date and shows short dates', () => {
    const now = new Date(2026, 9, 10).getTime()
    expect(todos.isOverdue('01/15/2020', now)).toBe(true)
    expect(todos.isOverdue('2026-12-24', now)).toBe(false)
    expect(todos.isOverdue('tomorrow', now)).toBe(false)
    expect(todos.showDate('10/09/2026', now)).toBe('Oct 9')
    expect(todos.showDate('01/15/2020', now)).toBe('Jan 15, 2020')
    expect(todos.showDate('tomorrow', now)).toBe('tomorrow')
  })
})

const PATH = '/p/acme/todos.md'

// todos.md in memory, under a session that runs in a desktop worktree.
const project = (on: On, initial: string | null) => {
  const disk = { text: initial, mtimeMs: 1 }
  on('session.root', () => ({ value: '/p/acme/.claude/worktrees/eager-turing' }))
  on('fs.exists', ($, e) => ({ value: e.path === PATH && disk.text !== null }))
  on('fs.stat', ($, e) =>
    e.path === PATH && disk.text !== null
      ? { value: { kind: 'file' as const, size: disk.text.length, mtimeMs: disk.mtimeMs, isLink: false } }
      : { deny: 'ENOENT' },
  )
  on('fs.read', ($, e) => (e.path === PATH && disk.text !== null ? { value: disk.text } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => {
    if (e.path !== PATH) return { deny: `unexpected write to ${e.path}` }
    disk.text = e.text
    disk.mtimeMs += 1

    return { value: undefined }
  })

  return disk
}

const PANE = {
  plugin: 'todo-sidebar',
  component: 'Pane',
  requestId: 'todos',
  props: {
    title: 'Todo',
    isFocused: true,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the sidebar adds an item, opens it, and edits title, status and description', async ($, on) => {
  const clock = mock.clock(on, { now: new Date(2026, 9, 10).getTime() })
  const disk = project(on, null)

  for (const surface of ['terminal', 'desktop'] as const) {
    disk.text = surface === 'terminal' ? null : SAMPLE
    disk.mtimeMs += 1
    const ui = await $.ui.mount({ ...PANE, surface })
    const key = async (type: string) => (await ui.find({ type }))!.key!
    const type = async (into: string, ...keys: string[]) => {
      for (const one of keys) await ui.key({ key: one, in: into })
    }

    await ui.input({ key: await key('Input'), text: 'Order the banner' })
    expect(disk.text).toContain('- [ ] Order the banner')

    const added = byTitle(disk.text!, 'Order the banner')
    await ui.press({ key: `open-${added.id}` })
    expect(await ui.find({ key: 'back' })).toBeDefined()

    await ui.select({ key: await key('Select'), value: 'doing' })
    expect(disk.text).toContain('- [/] Order the banner')

    // The description is one field of several lines, saved as it is typed;
    // a paste arrives as one key.
    await ui.press({ key: 'add-notes' })
    const notes = `notes-${added.id}`
    await type(notes, 'Vinyl, 2 m', 'return', 'P', 'i', 'c', 'k', 'space', 'u', 'p')
    expect(await ui.find({ in: notes, text: /^Pick up $/ })).toBeDefined()
    await clock.advance(1000)
    expect(disk.text).toContain('- [/] Order the banner\n  Vinyl, 2 m\n  Pick up\n')

    await type(notes, 'up', 'end', 'backspace', 'backspace')
    await ui.key({ key: 'return', meta: true, in: notes })
    expect(disk.text).toContain('- [/] Order the banner\n  Vinyl, 2\n  Pick up\n')
    expect(await ui.find({ key: notes })).toBeUndefined()

    // The title is a heading until edit turns it into a field; Enter saves.
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('## Order the banner')
    await ui.press({ key: 'edit-title' })
    const title = `title-${added.id}`
    await type(title, 'backspace', 'backspace', 'backspace', 'backspace', 'backspace', 'backspace', 'big banner', 'return')
    expect(disk.text).toContain('- [/] Order the big banner\n  Vinyl')
    expect(await ui.find({ key: 'edit-title' })).toBeDefined()

    // A typed title is saved on the way back, without Enter.
    const renamedTitle = `title-${byTitle(disk.text!, 'Order the big banner').id}`
    await ui.press({ key: 'edit-title' })
    await type(renamedTitle, 'left', 'left', 'left', 'left', 'left', 'left', 'blue ')
    await ui.press({ key: 'back' })
    expect(disk.text).toContain('- [/] Order the big blue banner\n  Vinyl')
    expect(await ui.find({ key: 'back' })).toBeUndefined()

    // The glyph opens the statuses under its row; a pick closes them.
    const renamed = byTitle(disk.text!, 'Order the big blue banner')
    expect((await ui.find({ key: `status-${renamed.id}` }))?.props.label).toBe('◐')
    await ui.press({ key: `status-${renamed.id}` })
    expect(await ui.find({ key: `set-${renamed.id}-waiting` })).toBeDefined()
    await ui.press({ key: `set-${renamed.id}-done` })
    expect(disk.text).toContain('- [x] Order the big blue banner | Done: 10/10/2026\n  Vinyl')
    expect(await ui.find({ key: `set-${renamed.id}-todo` })).toBeUndefined()

    if (!(await ui.find({ key: `open-${renamed.id}` }))) await ui.press({ key: 'toggle-done' })
    await ui.press({ key: `open-${renamed.id}` })
    await ui.press({ key: `arm-${renamed.id}` })
    await ui.press({ key: `remove-${renamed.id}` })
    expect(disk.text).not.toContain('banner')
    expect(disk.text).not.toContain('Vinyl')

    await ui.unmount()
  }
})

test('the sidebar groups open items by status and shows a description as markdown', async ($, on) => {
  mock.clock(on, { now: new Date(2026, 9, 10).getTime() })
  project(on, SAMPLE)
  await $.tool.call({ tool: 'mcp__todo-sidebar__todo', action: 'list' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ key: 'group-doing' }))?.text).toBe('In progress')
  expect((await ui.find({ key: 'group-waiting-fold' }))?.text).toBe('▾')
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('2 of 5 done')

  // A status heading folds its items away, and back.
  const waiting = byTitle(SAMPLE, 'Check the marketing rules').id
  expect(await ui.find({ key: `open-${waiting}` })).toBeDefined()
  await ui.press({ key: 'group-waiting' })
  expect(await ui.find({ key: `open-${waiting}` })).toBeUndefined()
  expect((await ui.find({ key: 'group-waiting-fold' }))?.text).toBe('▸')
  await ui.press({ key: 'group-waiting' })
  expect(await ui.find({ key: `open-${waiting}` })).toBeDefined()

  // Drawn again when only its focus changed, the pane's Buttons still work.
  await ui.redraw({ ...PANE.props, isFocused: false })
  await ui.press({ key: 'group-waiting' })
  expect(await ui.find({ key: `open-${waiting}` })).toBeUndefined()
  await ui.press({ key: 'group-waiting' })

  await ui.press({ key: `open-${byTitle(SAMPLE, 'Turn on Google login').id}` })
  const [heading, notes] = await ui.findAll({ type: 'Markdown' })
  expect(heading?.props.text).toBe('## Turn on Google login')
  expect(notes?.props.text).toBe('Google Cloud: OAuth client with a redirect.\n\nThen set NUXT_PUBLIC_LOGIN_PROVIDERS=google in Vercel.')

  await ui.unmount()
})

test("an item's page moves its status with buttons and asks before deleting", async ($, on) => {
  mock.clock(on, { now: new Date(2026, 9, 10).getTime() })
  const disk = project(on, SAMPLE)
  const id = byTitle(SAMPLE, 'Ship to production').id

  for (const surface of ['terminal', 'desktop'] as const) {
    disk.text = SAMPLE
    disk.mtimeMs += 1
    await $.tool.call({ tool: 'mcp__todo-sidebar__todo', action: 'list' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: `open-${id}` })

    // The likeliest move is the primary button; the rest are secondary.
    expect((await ui.find({ key: 'move-doing' }))?.props.variant).toBe('primary')
    expect((await ui.find({ key: 'move-done' }))?.props.variant).toBe('secondary')
    expect((await ui.find({ key: 'back' }))?.props.plain).toBeUndefined()

    await ui.press({ key: 'move-doing' })
    expect(disk.text).toContain('- [/] Ship to production')
    expect(await ui.find({ key: 'move-waiting' })).toBeDefined()

    await ui.press({ key: 'move-done' })
    expect(disk.text).toContain('## Completed\n- [x] Ship to production | Done: 10/10/2026')
    expect((await ui.find({ key: 'move-todo' }))?.props.label).toBe('↺ Reopen')

    // Delete asks first, and Keep leaves the item as it was.
    await ui.press({ key: `arm-${id}` })
    expect(await ui.find({ text: 'Delete this task?' })).toBeDefined()
    await ui.press({ key: `keep-${id}` })
    expect(await ui.find({ key: `remove-${id}` })).toBeUndefined()
    expect(disk.text).toContain('Ship to production')

    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('the model lists and changes the list through its tool', async ($, on) => {
  mock.clock(on, { now: new Date(2026, 9, 10).getTime() })
  const disk = project(on, SAMPLE)
  const tool = 'mcp__todo-sidebar__todo'

  const listed = await $.tool.call({ tool, action: 'list' })
  expect(String(listed.result)).toContain('Open (3):')
  expect(String(listed.result)).toContain('[doing] Turn on Google login (due 01/15/2020)')
  expect(String(listed.result)).toContain('     Then set')

  await $.tool.call({ tool, action: 'add', title: 'Write the newsletter', description: 'To all sponsors', status: 'doing' })
  expect(disk.text).toContain('- [/] Write the newsletter\n  To all sponsors\n\n## Completed')

  const id = byTitle(SAMPLE, 'Ship to production').id
  await $.tool.call({ tool, action: 'update', id, status: 'done' })
  expect(disk.text).toContain('## Completed\n- [x] Ship to production | Done: 10/10/2026')

  const wrong = await $.tool.call({ tool, action: 'update', id, status: 'started' })
  expect(wrong.deny).toContain('Unknown status')

  const missing = await $.tool.call({ tool, action: 'remove', id: 'nope' })
  expect(missing.deny).toContain('Nothing changed')
})

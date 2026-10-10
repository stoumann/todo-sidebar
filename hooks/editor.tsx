// A text field the plugin draws itself, for the surfaces whose own Input is
// one short line: as wide as the pane, one or several lines, a block cursor.
// It keeps the text as the person edits it and posts each change to the
// hooks module, `{ kind: 'change' | 'submit', text }`; Enter submits a
// one-line field and starts a new line in a multi-line one, where
// cmd+Enter submits.

import type { ClientKeyEvent, ClientModule } from 'claude-code'

export type EditorProps = {
  text: string
  placeholder: string
  isMultiline: boolean
  rows: number
  isBold: boolean
}

type EditorState = { text: string; cursor: number }

// Named keys that type nothing; any other key is the text it types, a
// paste included.
const SILENT = new Set([
  'escape',
  'tab',
  'insert',
  'pageup',
  'pagedown',
  'capslock',
  'clear',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
])

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1

const lineEnd = (text: string, at: number) => {
  const end = text.indexOf('\n', at)

  return end < 0 ? text.length : end
}

// One step left or right, never splitting an emoji's surrogate pair.
const step = (text: string, at: number, by: -1 | 1) => {
  const next = Math.max(0, Math.min(text.length, at + by))
  const code = text.charCodeAt(by < 0 ? next : at)

  return code >= 0xd800 && code <= 0xdbff && by > 0 ? Math.min(text.length, next + 1) : code >= 0xdc00 && code <= 0xdfff && by < 0 ? Math.max(0, next - 1) : next
}

// The same column on the line above or below, as far as that line reaches.
const vertical = (text: string, at: number, by: -1 | 1) => {
  const start = lineStart(text, at)
  const column = at - start
  if (by < 0) {
    if (start === 0) return 0
    const above = lineStart(text, start - 1)

    return Math.min(above + column, start - 1)
  }
  const end = lineEnd(text, at)
  if (end === text.length) return text.length

  return Math.min(end + 1 + column, lineEnd(text, end + 1))
}

const splice = (state: EditorState, from: number, to: number, insert: string): EditorState => ({
  text: state.text.slice(0, from) + insert + state.text.slice(to),
  cursor: from + insert.length,
})

const edit = (state: EditorState, key: ClientKeyEvent, isMultiline: boolean): EditorState | 'submit' | null => {
  const { text, cursor } = state
  const move = (to: number): EditorState => ({ text, cursor: to })

  switch (key.key) {
    case 'return':
    case 'enter':
      return isMultiline && !key.meta && !key.ctrl ? splice(state, cursor, cursor, '\n') : 'submit'
    case 'backspace':
      if (cursor === 0) return null
      return splice(state, key.meta ? lineStart(text, cursor - 1) : step(text, cursor, -1), cursor, '')
    case 'delete':
      if (cursor === text.length) return null
      return splice(state, cursor, step(text, cursor, 1), '')
    case 'left':
      return move(key.meta ? lineStart(text, cursor) : step(text, cursor, -1))
    case 'right':
      return move(key.meta ? lineEnd(text, cursor) : step(text, cursor, 1))
    case 'up':
      return move(key.meta ? 0 : vertical(text, cursor, -1))
    case 'down':
      return move(key.meta ? text.length : vertical(text, cursor, 1))
    case 'home':
      return move(lineStart(text, cursor))
    case 'end':
      return move(lineEnd(text, cursor))
    case 'space':
      return splice(state, cursor, cursor, ' ')
  }

  if (key.ctrl) {
    if (key.key === 'a') return move(lineStart(text, cursor))
    if (key.key === 'e') return move(lineEnd(text, cursor))

    return null
  }
  if (key.meta || SILENT.has(key.key)) return null

  const typed = key.key.replace(/\r\n?/g, '\n')

  return splice(state, cursor, cursor, isMultiline ? typed : typed.replace(/\n/g, ' '))
}

const Editor: ClientModule<EditorProps, EditorState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const current = () => surface.state ?? { text: props.text, cursor: props.text.length }

  surface.onKey(key => {
    const before = current()
    const after = edit(before, key, props.isMultiline)
    if (after === 'submit') return surface.post({ kind: 'submit', text: before.text })
    if (!after) return

    surface.setState(after)
    if (after.text !== before.text) surface.post({ kind: 'change', text: after.text })
  })

  // A click puts the cursor where it lands, reading the region as cells:
  // the border and padding first, then the lines as they wrap.
  surface.onPointer(event => {
    if (event.type !== 'down') return

    const { text } = current()
    const width = Math.max(1, surface.columns - 4)
    const row = Math.max(0, event.y - 1)
    const column = Math.max(0, event.x - 2)
    let top = 0
    let offset = 0
    for (const [i, line] of text.split('\n').entries()) {
      const height = Math.max(1, Math.ceil((line.length + 1) / width))
      if (row < top + height || i === text.split('\n').length - 1) {
        surface.setState({ text, cursor: offset + Math.min(line.length, (Math.min(row, top + height - 1) - top) * width + column) })

        return
      }
      top += height
      offset += line.length + 1
    }
  })

  const { text, cursor } = current()
  const lines = text.split('\n')
  const at = lineStart(text, cursor)
  const cursorLine = text.slice(0, at).split('\n').length - 1
  const column = cursor - at

  return (
    <Box flexDirection="column" width="100%" minHeight={props.rows + 2} borderStyle="round" borderColor="suggestion" paddingX={1}>
      {text === '' ? (
        <Text>
          <Text inverse> </Text>
          <Text dimColor>{props.placeholder}</Text>
        </Text>
      ) : (
        lines.map((line, i) =>
          i === cursorLine ? (
            <Text bold={props.isBold}>
              {line.slice(0, column)}
              <Text inverse>{line.slice(column, step(line, column, 1)) || ' '}</Text>
              {line.slice(step(line, column, 1))}
            </Text>
          ) : (
            <Text bold={props.isBold}>{line === '' ? ' ' : line}</Text>
          ),
        )
      )}
    </Box>
  )
}

export default Editor

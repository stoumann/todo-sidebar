export type Status = 'todo' | 'doing' | 'waiting' | 'done' | 'dropped'

export type Todo = {
  id: string
  status: Status
  title: string
  description: string
  due: string | null
  doneAt: string | null
}

export type TodoFile = {
  path: string
  mtimeMs: number
  items: Todo[]
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'todo-sidebar': {
      list: TodoFile | null
      showDone: boolean
      armed: string | null
      formKey: number
      selected: string | null
      isEditingNotes: boolean
      isEditingTitle: boolean
      statusMenu: string | null
      hasEditorFault: boolean
      collapsed: Status[]
    }
  }
}

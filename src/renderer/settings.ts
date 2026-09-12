/**
 * The settings window: everything the person sets by hand, and the register of
 * the projects they have been asked about.
 *
 * It draws what the main process sends and nothing it asked for: a change goes
 * out as a request, and the answer comes back as a fresh snapshot pushed at
 * this window. The rows themselves come from `preferences.ts`, which the main
 * process reads too — there is no second copy of the list here.
 */
import {
  asKept,
  type PreferenceKey,
  projectRows,
  type Row,
  rowsFor,
  type SettingsSnapshot,
} from '../main/preferences.ts'

declare const ab: {
  settings(): Promise<SettingsSnapshot>
  openAtLogin(on: boolean): Promise<unknown>
  announceAutomation(on: boolean): Promise<unknown>
  orphanCloseMs(ms: number): Promise<unknown>
  presence(value: string): Promise<unknown>
  forgetProject(root: string): Promise<unknown>
  on(channel: 'settings', handler: (payload: unknown) => void): () => void
}

const root = document.getElementById('root')!

/** The last answer from the main process; `null` until the first one arrives. */
let snapshot: SettingsSnapshot | null = null

function render(): void {
  root.innerHTML = ''
  if (!snapshot) {
    root.append(el('p', 'hint', 'Reading the settings…'))
    return
  }
  root.append(el('h6', '', 'General'))
  const general = el('div', 'group')
  for (const row of rowsFor(snapshot)) general.append(renderSetting(row))
  root.append(general)

  root.append(el('h6', '', 'Projects'))
  root.append(renderProjects(snapshot))
  root.append(
    el(
      'p',
      'note hint',
      'Naoba asks you about a project the first time an agent working there wants a browser. ' +
        'Forget one and Naoba asks about it again next time. ' +
        'A project that already has a browser keeps its tabs and its logins.',
    ),
  )
}

function renderSetting(row: Row): HTMLElement {
  const node = el('div', 'setting')
  const text = el('div', 'text')
  text.append(el('span', 'label', row.label), el('span', 'hint', row.hint))
  node.append(text)
  node.append(control(row))
  return node
}

/** The row's own control, one per kind of preference there is. */
function control(row: Row): HTMLElement {
  switch (row.kind) {
    case 'switch':
      return switchControl(row.on, (on) => void commit(row.key, on))
    case 'number':
      return amount(row)
    case 'choice':
      return segmented(row, (value) => void commit(row.key, value))
  }
}

/** A number and the unit it is typed in, so the field itself carries no words. */
function amount(row: Extract<Row, { kind: 'number' }>): HTMLElement {
  const wrap = el('div', 'amount')
  wrap.append(numberField(row.value, row.floor, (value) => void commit(row.key, value)), el('span', 'unit', row.unit))
  return wrap
}

/**
 * A choice of a few, the way macOS draws one: the segments side by side with
 * the current one filled, rather than a menu that hides the alternatives until
 * it is opened.
 */
function segmented(row: Extract<Row, { kind: 'choice' }>, onPick: (value: string) => void): HTMLElement {
  const group = el('div', 'segmented')
  group.setAttribute('role', 'radiogroup')
  for (const option of row.options) {
    const node = document.createElement('button')
    const picked = option.value === row.value
    node.className = picked ? 'segment on' : 'segment'
    node.textContent = option.label
    node.setAttribute('role', 'radio')
    node.setAttribute('aria-checked', String(picked))
    node.onclick = () => {
      if (!picked) onPick(option.value)
    }
    group.append(node)
  }
  return group
}

/**
 * The directories the person has answered about. A refusal is why an agent
 * working there gets nothing, so it is listed as plainly as an admission.
 */
function renderProjects(values: SettingsSnapshot): HTMLElement {
  const group = el('div', 'group')
  const rows = projectRows(values.projects)
  if (rows.length === 0) {
    group.append(el('p', 'empty hint', 'No agent has asked for a browser yet.'))
    return group
  }
  for (const project of rows) {
    const node = el('div', 'setting project')
    const text = el('div', 'text')
    const name = el('div', 'name')
    name.append(el('span', project.allowed ? 'dot' : 'dot refused'), el('span', '', project.name))
    text.append(name, el('span', 'path', project.root), el('span', 'hint', project.hint))
    node.append(text)
    node.append(
      button('Forget', () => void ab.forgetProject(project.root), 'Ask about this directory again next time'),
    )
    group.append(node)
  }
  return group
}

/**
 * Send the change and stop. The main process clamps the value, applies it live,
 * writes it down and pushes the result back at this window — so drawing what
 * was asked for here would be drawing a guess.
 */
async function commit(key: PreferenceKey, value: boolean | number | string): Promise<void> {
  switch (key) {
    case 'loginItem':
      await ab.openAtLogin(value as boolean)
      return
    case 'presence':
      await ab.presence(value as string)
      return
    case 'announceAutomation':
      await ab.announceAutomation(value as boolean)
      return
    case 'orphanCloseMs': {
      const kept = asKept(key, value as number)
      if (kept !== null) await ab.orphanCloseMs(kept)
      return
    }
    default: {
      // A preference added with no way to write it fails here, at the compiler,
      // rather than silently doing nothing when the person touches its row.
      const unreachable: never = key
      throw new Error(`nothing writes ${String(unreachable)}`)
    }
  }
}

// ------------------------------------------------------------------ elements

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

/** A macOS-style switch: a button that carries its state, so the keyboard reaches it too. */
function switchControl(on: boolean, onChange: (on: boolean) => void): HTMLElement {
  const node = document.createElement('button')
  node.className = on ? 'switch on' : 'switch'
  node.setAttribute('role', 'switch')
  node.setAttribute('aria-checked', String(on))
  node.append(el('span', 'knob'))
  node.onclick = () => onChange(!on)
  return node
}

/** A number the person types and commits with Enter or by leaving the field. */
function numberField(value: number, min: number, onCommit: (value: number) => void): HTMLElement {
  const input = document.createElement('input')
  input.type = 'number'
  input.className = 'number'
  input.min = String(min)
  input.value = String(value)
  const commitValue = () => {
    const next = Number(input.value)
    if (!Number.isFinite(next) || next === value) return
    onCommit(next)
  }
  input.onblur = commitValue
  input.onkeydown = (event) => {
    if (event.key === 'Enter') input.blur()
  }
  return input
}

function button(label: string, onClick: () => void, title = ''): HTMLElement {
  const node = document.createElement('button')
  node.textContent = label
  node.title = title
  node.onclick = onClick
  return node
}

// ----------------------------------------------------------------- lifecycle

ab.on('settings', (payload) => {
  snapshot = payload as SettingsSnapshot
  render()
})

void ab.settings().then((values) => {
  snapshot = values
  render()
})

render()

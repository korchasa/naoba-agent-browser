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
  buyLicence(): Promise<unknown>
  activateLicence(key: string): Promise<unknown>
  deactivateLicence(): Promise<unknown>
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
  root.append(el('h6', '', 'Licence'))
  root.append(renderLicence(snapshot))

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

/** What is being typed into the key field, kept across a redraw the push causes. */
let typedKey = ''
/** What went wrong the last time a key was sent, in the words the main process used. */
let licenceError = ''
let sending = false

/**
 * The licence, and the only thing in this window that is not a preference: it
 * is a fact about this copy, and the one thing without which an agent is
 * refused.
 */
function renderLicence(values: SettingsSnapshot): HTMLElement {
  const group = el('div', 'group')
  const node = el('div', values.licence.licensed ? 'setting licence' : 'setting licence refused')
  const text = el('div', 'text')
  const name = el('div', 'name')
  name.append(el('span', 'dot'), el('span', '', values.licence.licensed ? 'Unlocked' : 'Not unlocked'))
  text.append(name, el('span', 'hint', values.licence.sentence))
  if (values.licence.tail) {
    const checked = values.licence.checkedOn ? `, last confirmed ${values.licence.checkedOn}` : ''
    text.append(el('span', 'hint', `Key ending ${values.licence.tail}${checked}.`))
  }
  node.append(text)
  node.append(
    values.licence.licensed
      ? button('Deactivate', () => void hand(() => ab.deactivateLicence()), 'Free this key for another Mac')
      : button('Buy a key', () => void ab.buyLicence(), 'Opens the shop in your own browser'),
  )
  group.append(node)

  if (!values.licence.licensed) group.append(unlockRow())
  return group
}

/** The field a key is typed into, and the button that sends it. */
function unlockRow(): HTMLElement {
  const node = el('div', 'setting licence')
  const text = el('div', 'text')
  text.append(
    el('span', 'label', 'Licence key'),
    el('span', 'hint', 'From the receipt you were sent after buying. It unlocks this Mac.'),
  )
  if (licenceError) text.append(el('span', 'hint error', licenceError))
  node.append(text)

  const field = document.createElement('input')
  field.type = 'text'
  field.className = 'key'
  field.placeholder = 'sk_…'
  field.value = typedKey
  field.spellcheck = false
  field.oninput = () => {
    typedKey = field.value
  }
  field.onkeydown = (event) => {
    if (event.key === 'Enter') void unlock()
  }

  const send = button(sending ? 'Unlocking…' : 'Unlock', () => void unlock())
  const wrap = el('div', 'entry')
  wrap.append(field, send)
  node.append(wrap)
  return node
}

async function unlock(): Promise<void> {
  if (sending || !typedKey.trim()) return
  sending = true
  licenceError = ''
  render()
  await hand(() => ab.activateLicence(typedKey))
  sending = false
  render()
}

/**
 * Run a licence call and keep whatever it complained about. The main process
 * answers with a fresh snapshot of its own, so nothing is drawn from the reply.
 */
async function hand(call: () => Promise<unknown>): Promise<void> {
  try {
    await call()
    typedKey = ''
    licenceError = ''
  } catch (error) {
    // An error crossing the IPC boundary arrives wrapped in the name of the
    // channel it came from; the sentence written for the person is the tail.
    const message = error instanceof Error ? error.message : String(error)
    licenceError = message.split(': ').slice(-1)[0] || message
  }
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
    // The state goes on the row, not on the lamp alone: a refused directory
    // reads quieter as a whole, the way a record that is not in force should.
    const node = el('div', project.allowed ? 'setting project' : 'setting project refused')
    const text = el('div', 'text')
    const name = el('div', 'name')
    name.append(el('span', 'dot'), el('span', '', project.name))
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

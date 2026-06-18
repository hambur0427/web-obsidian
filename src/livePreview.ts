import { redo, undo } from '@codemirror/commands'
import { StateField } from '@codemirror/state'
import type { EditorState, Range, Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

// ── Inline marks ─────────────────────────────────────────────────────────────

const mkHidden   = Decoration.mark({ class: 'cm-md-hidden' })
const mkBold     = Decoration.mark({ class: 'cm-md-bold' })
const mkItalic   = Decoration.mark({ class: 'cm-md-italic' })
const mkCode     = Decoration.mark({ class: 'cm-md-code' })
const mkStrike   = Decoration.mark({ class: 'cm-md-strike' })
const mkWikiLink = Decoration.mark({ class: 'cm-md-wikilink' })
const mkHeadings = [1, 2, 3, 4, 5, 6].map((l) => Decoration.mark({ class: `cm-md-h${l}` }))

// ── Line decorations for code blocks ──────────────────────────────────────────

const lnCode       = Decoration.line({ class: 'cm-code-line' })
const lnCodeFirst  = Decoration.line({ class: 'cm-code-line cm-code-first' })
const lnCodeLast   = Decoration.line({ class: 'cm-code-line cm-code-last' })
const lnCodeFence  = Decoration.line({ class: 'cm-code-line cm-code-fence' })

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'

// ── Copy button widget (floats on the right of the opening fence line) ─────────

class CopyButtonWidget extends WidgetType {
  private code: string
  constructor(code: string) { super(); this.code = code }

  eq(other: CopyButtonWidget) {
    return other.code === this.code
  }

  toDOM() {
    const btn = document.createElement('button')
    btn.className = 'cm-code-copy'
    btn.type = 'button'
    btn.innerHTML = `${COPY_ICON}<span>Copy</span>`

    const code = this.code
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      void navigator.clipboard.writeText(code).then(() => {
        const text = btn.querySelector('span')
        if (text) {
          text.textContent = 'Copied'
          btn.classList.add('copied')
          window.setTimeout(() => {
            text.textContent = 'Copy'
            btn.classList.remove('copied')
          }, 1400)
        }
      })
    })

    return btn
  }

  ignoreEvent() { return true }
}

// ── Table widget (interactive editor) ─────────────────────────────────────────

function escapeCell(value: string) {
  return value.replace(/\|/g, '\\|').trim()
}

function serializeTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map(escapeCell).join(' | ')} |`
  const sep  = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map(
    (r) => `| ${headers.map((_, c) => escapeCell(r[c] ?? '')).join(' | ')} |`,
  )
  return [head, sep, ...body].join('\n')
}

class TableWidget extends WidgetType {
  private headers: string[]
  private rows: string[][]
  private from: number
  private to: number
  constructor(headers: string[], rows: string[][], from: number, to: number) {
    super()
    this.headers = headers
    this.rows = rows
    this.from = from
    this.to = to
  }

  eq(other: TableWidget) {
    return (
      other.from === this.from &&
      other.to === this.to &&
      JSON.stringify(other.headers) === JSON.stringify(this.headers) &&
      JSON.stringify(other.rows)    === JSON.stringify(this.rows)
    )
  }

  toDOM(view: EditorView) {
    // Local working copy; the document is only rewritten on commit.
    const headers = [...this.headers]
    const rows    = this.rows.map((r) => [...r])
    const from = this.from
    const to   = this.to

    const commit = () => {
      view.dispatch({
        changes: { from, to, insert: serializeTable(headers, rows) },
      })
    }

    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table'

    // Route editor shortcuts (undo/redo) to CodeMirror even when a cell input
    // is focused, otherwise the browser would undo the input in isolation.
    wrap.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault(); undo(view); view.focus()
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault(); redo(view); view.focus()
      }
    })

    const table = document.createElement('table')

    const thead = document.createElement('thead')
    const htr   = document.createElement('tr')
    headers.forEach((h, c) => {
      const th = document.createElement('th')
      const input = document.createElement('input')
      input.value = h
      input.addEventListener('mousedown', (e) => e.stopPropagation())
      input.addEventListener('change', () => { headers[c] = input.value; commit() })
      th.appendChild(input)
      htr.appendChild(th)
    })
    thead.appendChild(htr)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    rows.forEach((row, r) => {
      const tr = document.createElement('tr')
      headers.forEach((_, c) => {
        const td = document.createElement('td')
        const input = document.createElement('input')
        input.value = row[c] ?? ''
        input.addEventListener('mousedown', (e) => e.stopPropagation())
        input.addEventListener('change', () => { rows[r][c] = input.value; commit() })
        td.appendChild(input)
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    wrap.appendChild(table)

    // Toolbar
    const bar = document.createElement('div')
    bar.className = 'cm-md-table-toolbar'

    const mkBtn = (label: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
      return b
    }

    bar.appendChild(mkBtn('+ Column', () => {
      headers.push('Column')
      rows.forEach((r) => r.push(''))
      commit()
    }))
    bar.appendChild(mkBtn('− Column', () => {
      if (headers.length <= 1) return
      headers.pop()
      rows.forEach((r) => r.pop())
      commit()
    }))
    bar.appendChild(mkBtn('+ Row', () => {
      rows.push(headers.map(() => ''))
      commit()
    }))
    bar.appendChild(mkBtn('− Row', () => {
      if (!rows.length) return
      rows.pop()
      commit()
    }))

    const delBtn = mkBtn('Delete table', () => {
      const docLen = view.state.doc.length
      let delTo = to
      // Also swallow the trailing newline so no blank line is left behind.
      if (delTo < docLen && view.state.doc.sliceString(delTo, delTo + 1) === '\n') {
        delTo += 1
      }
      view.dispatch({ changes: { from, to: delTo, insert: '' } })
      view.focus()
    })
    delBtn.classList.add('danger')
    bar.appendChild(delBtn)

    wrap.appendChild(bar)
    return wrap
  }

  ignoreEvent() { return true }
}

// ── Block detection ───────────────────────────────────────────────────────────

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())
}

function isTableSep(line: string) {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

type CodeBlock  = { type: 'code'; fromLine: number; toLine: number; lang: string; code: string }
type TableBlock = { type: 'table'; fromLine: number; toLine: number; headers: string[]; rows: string[][] }
type Block = CodeBlock | TableBlock

function makeCodeBlock(doc: Text, fromLine: number, toLine: number): CodeBlock {
  const openText = doc.line(fromLine).text
  const lang = /^(?:`{3,}|~{3,})(\w*)/.exec(openText)?.[1] ?? ''
  const codeLines: string[] = []
  for (let n = fromLine + 1; n <= toLine - 1; n++) codeLines.push(doc.line(n).text)
  return { type: 'code', fromLine, toLine, lang, code: codeLines.join('\n') }
}

function findBlocks(doc: Text): Block[] {
  const blocks: Block[] = []
  const consumed = new Set<number>()

  // Code fences
  let fenceStart = -1
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text
    if (/^(`{3,}|~{3,})/.test(text)) {
      if (fenceStart === -1) {
        fenceStart = i
      } else {
        blocks.push(makeCodeBlock(doc, fenceStart, i))
        for (let n = fenceStart; n <= i; n++) consumed.add(n)
        fenceStart = -1
      }
    }
  }
  // Unclosed fence → treat to end of doc
  if (fenceStart !== -1) {
    blocks.push(makeCodeBlock(doc, fenceStart, doc.lines))
    for (let n = fenceStart; n <= doc.lines; n++) consumed.add(n)
  }

  // Tables
  let tStart = -1
  let tLines: string[] = []
  const flush = (endLine: number) => {
    if (tStart !== -1 && tLines.length >= 2 && isTableSep(tLines[1]) && endLine >= tStart) {
      blocks.push({
        type: 'table',
        fromLine: tStart,
        toLine: endLine,
        headers: splitRow(tLines[0]),
        rows: tLines.slice(2).map(splitRow),
      })
    }
    tStart = -1; tLines = []
  }
  for (let i = 1; i <= doc.lines; i++) {
    if (consumed.has(i)) { flush(i - 1); continue }
    const text = doc.line(i).text
    if (/^\|/.test(text)) {
      if (tStart === -1) tStart = i
      tLines.push(text)
    } else {
      flush(i - 1)
    }
  }
  flush(doc.lines)

  blocks.sort((a, b) => a.fromLine - b.fromLine)
  return blocks
}

// ── Inline decorations ────────────────────────────────────────────────────────

function collectInline(offset: number, text: string, out: Range<Decoration>[]) {
  const items: { from: number; to: number; deco: Decoration }[] = []

  function push(m: RegExpExecArray, openLen: number, closeLen: number, deco: Decoration) {
    const s = offset + m.index!
    const e = s + m[0].length
    const iFrom = s + openLen
    const iTo   = e - closeLen
    if (iFrom >= iTo) return
    items.push({ from: s, to: iFrom, deco: mkHidden })
    items.push({ from: iFrom, to: iTo, deco })
    items.push({ from: iTo, to: e, deco: mkHidden })
  }

  for (const m of text.matchAll(/\*\*([^*\n]{1,300}?)\*\*/g))                        push(m, 2, 2, mkBold)
  for (const m of text.matchAll(/(?<!\*)\*(?!\*)([^*\n]{1,300}?)(?<!\*)\*(?!\*)/g)) push(m, 1, 1, mkItalic)
  for (const m of text.matchAll(/`([^`\n]{1,300}?)`/g))                              push(m, 1, 1, mkCode)
  for (const m of text.matchAll(/~~([^~\n]{1,300}?)~~/g))                            push(m, 2, 2, mkStrike)

  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g)) {
    const s = offset + m.index!
    const e = s + m[0].length
    if (m[2] !== undefined) {
      const pipePos = s + m[0].lastIndexOf('|')
      if (pipePos + 1 < e - 2) {
        items.push({ from: s,           to: pipePos + 1, deco: mkHidden })
        items.push({ from: pipePos + 1, to: e - 2,       deco: mkWikiLink })
        items.push({ from: e - 2,       to: e,            deco: mkHidden })
      }
    } else if (s + 2 < e - 2) {
      items.push({ from: s,     to: s + 2, deco: mkHidden })
      items.push({ from: s + 2, to: e - 2, deco: mkWikiLink })
      items.push({ from: e - 2, to: e,     deco: mkHidden })
    }
  }

  items.sort((a, b) => a.from - b.from || a.to - b.to)
  let lastTo = -Infinity
  for (const item of items) {
    if (item.from >= lastTo) {
      out.push(item.deco.range(item.from, item.to))
      lastTo = Math.max(lastTo, item.to)
    }
  }
}

// ── Decoration builder ────────────────────────────────────────────────────────

function buildDecorations(state: EditorState): DecorationSet {
  const doc     = state.doc
  const sel     = state.selection.main
  const curFrom = doc.lineAt(sel.from).number
  const curTo   = doc.lineAt(sel.to).number
  const blocks  = findBlocks(doc)
  const ranges: Range<Decoration>[] = []

  const blockLineType = new Map<number, 'code' | 'table'>()
  for (const b of blocks) {
    for (let n = b.fromLine; n <= b.toLine; n++) blockLineType.set(n, b.type)
  }

  for (const block of blocks) {
    const active = block.fromLine <= curTo && block.toLine >= curFrom

    if (block.type === 'code') {
      // Code is always editable text. The ``` fence lines stay visible
      // (dimmed) as reserved top/bottom strips; the copy button sits on the
      // right of the opening fence line, on the same row as the ```.
      for (let n = block.fromLine; n <= block.toLine; n++) {
        const line    = doc.line(n)
        const isOpen  = n === block.fromLine
        const isClose = n === block.toLine

        if (isOpen) ranges.push(lnCodeFirst.range(line.from))
        else if (isClose) ranges.push(lnCodeLast.range(line.from))
        else ranges.push(lnCode.range(line.from))

        if (isOpen || isClose) {
          if (active) {
            // While editing, reveal the raw ``` markers (dimmed)
            ranges.push(lnCodeFence.range(line.from))
          } else if (line.to > line.from) {
            // When idle, hide the ``` text but keep the row as reserved space
            ranges.push(mkHidden.range(line.from, line.to))
          }
        }

        if (isOpen && !active) {
          ranges.push(
            Decoration.widget({
              widget: new CopyButtonWidget(block.code),
              side: 1,
            }).range(line.to),
          )
        }
      }
    } else {
      // Table: always an interactive widget (no raw-syntax editing)
      const from = doc.line(block.fromLine).from
      const to   = doc.line(block.toLine).to
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(block.headers, block.rows, from, to),
          block: true,
        }).range(from, to),
      )
    }
  }

  // Inline / heading decorations for lines not inside a block
  for (let i = 1; i <= doc.lines; i++) {
    if (blockLineType.has(i)) continue

    const line     = doc.line(i)
    const isActive = i >= curFrom && i <= curTo
    const { text, from: lFrom, to: lTo } = line
    const hm = /^(#{1,6}) /.exec(text)

    if (hm) {
      const level     = hm[1].length
      const prefixEnd = lFrom + hm[0].length
      if (!isActive)        ranges.push(mkHidden.range(lFrom, prefixEnd))
      if (prefixEnd <= lTo) ranges.push(mkHeadings[level - 1].range(prefixEnd, lTo))
      if (!isActive && prefixEnd < lTo) collectInline(prefixEnd, text.slice(hm[0].length), ranges)
    } else if (!isActive) {
      collectInline(lFrom, text, ranges)
    }
  }

  return Decoration.set(ranges, true)
}

// ── StateField ────────────────────────────────────────────────────────────────

const livePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state)
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

// ── Exports ───────────────────────────────────────────────────────────────────

export function createLivePreviewExtensions(onNavigate: (target: string) => void) {
  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      // Ctrl/Cmd-click on a wiki link → navigate
      if (!event.ctrlKey && !event.metaKey) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos === null) return false
      const line      = view.state.doc.lineAt(pos)
      const posInLine = pos - line.from
      for (const m of line.text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
        if (posInLine >= m.index! && posInLine <= m.index! + m[0].length) {
          event.preventDefault()
          onNavigate(m[1].trim())
          return true
        }
      }
      return false
    },
  })

  return [livePreviewField, clickHandler]
}

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
const hideLine     = Decoration.replace({})

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'

// ── Code header widget (language label + copy button) ─────────────────────────

class CodeHeaderWidget extends WidgetType {
  private lang: string
  private code: string
  constructor(lang: string, code: string) { super(); this.lang = lang; this.code = code }

  eq(other: CodeHeaderWidget) {
    return other.lang === this.lang && other.code === this.code
  }

  toDOM() {
    const bar = document.createElement('div')
    bar.className = 'cm-code-header'

    const label = document.createElement('span')
    label.className = 'cm-code-lang'
    label.textContent = this.lang || 'code'
    bar.appendChild(label)

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
    bar.appendChild(btn)

    return bar
  }

  ignoreEvent() { return true }
}

// ── Table widget ──────────────────────────────────────────────────────────────

class TableWidget extends WidgetType {
  private headers: string[]
  private rows: string[][]
  constructor(headers: string[], rows: string[][]) { super(); this.headers = headers; this.rows = rows }

  eq(other: TableWidget) {
    return (
      JSON.stringify(other.headers) === JSON.stringify(this.headers) &&
      JSON.stringify(other.rows)    === JSON.stringify(this.rows)
    )
  }

  toDOM() {
    const wrap  = document.createElement('div')
    wrap.className = 'cm-preview-table'
    const table = document.createElement('table')

    if (this.headers.length) {
      const thead = document.createElement('thead')
      const tr    = document.createElement('tr')
      for (const h of this.headers) {
        const th = document.createElement('th')
        th.textContent = h
        tr.appendChild(th)
      }
      thead.appendChild(tr)
      table.appendChild(thead)
    }

    if (this.rows.length) {
      const tbody = document.createElement('tbody')
      for (const row of this.rows) {
        const tr = document.createElement('tr')
        for (let c = 0; c < this.headers.length; c++) {
          const td = document.createElement('td')
          td.textContent = row[c] ?? ''
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
    }

    wrap.appendChild(table)
    return wrap
  }

  ignoreEvent() { return false }
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
      // Code stays editable text. When the cursor is outside the block we
      // turn the opening fence into a header bar (language + copy button)
      // and hide the closing fence; clicking the code still edits in place.
      for (let n = block.fromLine; n <= block.toLine; n++) {
        const line   = doc.line(n)
        const isOpen  = n === block.fromLine
        const isClose = n === block.toLine && block.toLine !== block.fromLine

        if (!active && isOpen) {
          ranges.push(lnCodeFirst.range(line.from))
          ranges.push(
            Decoration.replace({
              widget: new CodeHeaderWidget(block.lang, block.code),
            }).range(line.from, line.to),
          )
        } else if (!active && isClose) {
          ranges.push(lnCodeLast.range(line.from))
          if (line.to > line.from) ranges.push(hideLine.range(line.from, line.to))
        } else {
          if (isOpen) ranges.push(lnCodeFirst.range(line.from))
          else if (n === block.toLine) ranges.push(lnCodeLast.range(line.from))
          else ranges.push(lnCode.range(line.from))
          // Dim the raw ``` markers while editing
          if (active && (isOpen || n === block.toLine)) {
            ranges.push(lnCodeFence.range(line.from))
          }
        }
      }
    } else {
      // Table: rendered widget when inactive, raw pipes when active
      if (!active) {
        const from = doc.line(block.fromLine).from
        const to   = doc.line(block.toLine).to
        ranges.push(
          Decoration.replace({
            widget: new TableWidget(block.headers, block.rows),
            block: true,
          }).range(from, to),
        )
      }
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
      const target = event.target as HTMLElement

      // Click on a rendered table → move cursor to its top so the raw
      // markdown is revealed for editing.
      const tableEl = target.closest<HTMLElement>('.cm-preview-table')
      if (tableEl) {
        event.preventDefault()
        const rect = tableEl.getBoundingClientRect()
        const pos  = view.posAtCoords({ x: rect.left + 4, y: rect.top + 2 })
        if (pos !== null) {
          view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
          view.focus()
        }
        return true
      }

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

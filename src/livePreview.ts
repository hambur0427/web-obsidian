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

const lnCode      = Decoration.line({ class: 'cm-code-line' })
const lnCodeFirst = Decoration.line({ class: 'cm-code-line cm-code-first' })
const lnCodeLast  = Decoration.line({ class: 'cm-code-line cm-code-last' })
const lnCodeFence = Decoration.line({ class: 'cm-code-line cm-code-fence' })

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

type CodeBlock  = { type: 'code'; fromLine: number; toLine: number }
type TableBlock = { type: 'table'; fromLine: number; toLine: number; headers: string[]; rows: string[][] }
type Block = CodeBlock | TableBlock

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
        blocks.push({ type: 'code', fromLine: fenceStart, toLine: i })
        for (let n = fenceStart; n <= i; n++) consumed.add(n)
        fenceStart = -1
      }
    }
  }
  // Unclosed fence → treat to end of doc
  if (fenceStart !== -1) {
    blocks.push({ type: 'code', fromLine: fenceStart, toLine: doc.lines })
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
      // Code stays editable text; we only style it like a block and hide
      // the ``` fences when the cursor is outside.
      for (let n = block.fromLine; n <= block.toLine; n++) {
        const line   = doc.line(n)
        const isFence = n === block.fromLine || n === block.toLine
        let lineDeco = lnCode
        if (n === block.fromLine) lineDeco = lnCodeFirst
        else if (n === block.toLine) lineDeco = lnCodeLast

        if (isFence && !active) {
          // Hide the fence text (keep the line as a thin styled strip)
          ranges.push(lnCodeFence.range(line.from))
          if (line.to > line.from) ranges.push(mkHidden.range(line.from, line.to))
        } else {
          ranges.push(lineDeco.range(line.from))
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

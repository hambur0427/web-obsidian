import { RangeSetBuilder } from '@codemirror/state'
import type { Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

type Item = { from: number; to: number; deco: Decoration }

// ── Inline marks ─────────────────────────────────────────────────────────────

const mkHidden   = Decoration.mark({ class: 'cm-md-hidden' })
const mkBold     = Decoration.mark({ class: 'cm-md-bold' })
const mkItalic   = Decoration.mark({ class: 'cm-md-italic' })
const mkCode     = Decoration.mark({ class: 'cm-md-code' })
const mkStrike   = Decoration.mark({ class: 'cm-md-strike' })
const mkWikiLink = Decoration.mark({ class: 'cm-md-wikilink' })
const mkHeadings = [1, 2, 3, 4, 5, 6].map((l) => Decoration.mark({ class: `cm-md-h${l}` }))

// ── Block widgets ─────────────────────────────────────────────────────────────

class CodeBlockWidget extends WidgetType {
  constructor(private lang: string, private content: string) { super() }

  eq(other: CodeBlockWidget) {
    return other.lang === this.lang && other.content === this.content
  }

  toDOM() {
    const wrap = document.createElement('div')
    wrap.className = 'cm-preview-codeblock'
    if (this.lang) {
      const label = document.createElement('span')
      label.className = 'cm-preview-codelang'
      label.textContent = this.lang
      wrap.appendChild(label)
    }
    const pre  = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = this.content
    pre.appendChild(code)
    wrap.appendChild(pre)
    return wrap
  }
}

class TableWidget extends WidgetType {
  constructor(private headers: string[], private rows: string[][]) { super() }

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
}

// ── Block range detection ─────────────────────────────────────────────────────

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())
}

function isTableSep(line: string) {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

interface BlockRange {
  from: number
  to: number
  fromLine: number
  toLine: number
  widget: Decoration
}

function findBlockRanges(doc: Text): BlockRange[] {
  const ranges: BlockRange[] = []

  // ── Code fences ──
  let fenceStart = -1
  let fenceLang  = ''
  let fenceLines: string[] = []

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const m = /^(`{3,}|~{3,})(\w*)/.exec(line.text)
    if (m) {
      if (fenceStart === -1) {
        fenceStart = i
        fenceLang  = m[2]
        fenceLines = []
      } else {
        ranges.push({
          from: doc.line(fenceStart).from,
          to: line.to,
          fromLine: fenceStart,
          toLine: i,
          widget: Decoration.replace({
            widget: new CodeBlockWidget(fenceLang, fenceLines.join('\n')),
          }),
        })
        fenceStart = -1
      }
    } else if (fenceStart !== -1) {
      fenceLines.push(line.text)
    }
  }

  // ── Tables (skipping content inside code fences) ──
  const fenceLineNums = new Set(ranges.flatMap((r) => {
    const nums: number[] = []
    for (let n = r.fromLine; n <= r.toLine; n++) nums.push(n)
    return nums
  }))

  let tableStart = -1
  let tableLines: string[] = []

  const flushTable = (endLine: number) => {
    if (
      tableStart !== -1 &&
      tableLines.length >= 2 &&
      isTableSep(tableLines[1]) &&
      endLine >= tableStart
    ) {
      ranges.push({
        from: doc.line(tableStart).from,
        to: doc.line(endLine).to,
        fromLine: tableStart,
        toLine: endLine,
        widget: Decoration.replace({
          widget: new TableWidget(splitRow(tableLines[0]), tableLines.slice(2).map(splitRow)),
        }),
      })
    }
    tableStart = -1
    tableLines = []
  }

  for (let i = 1; i <= doc.lines; i++) {
    if (fenceLineNums.has(i)) { flushTable(i - 1); continue }
    const line = doc.line(i)
    if (/^\|/.test(line.text)) {
      if (tableStart === -1) tableStart = i
      tableLines.push(line.text)
    } else {
      flushTable(i - 1)
    }
  }
  flushTable(doc.lines)

  ranges.sort((a, b) => a.from - b.from)
  return ranges
}

// ── Inline decoration collection ──────────────────────────────────────────────

function collectInline(offset: number, text: string): Item[] {
  const items: Item[] = []

  function push(m: RegExpExecArray, openLen: number, closeLen: number, deco: Decoration) {
    const s     = offset + m.index!
    const e     = s + m[0].length
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
        items.push({ from: s,          to: pipePos + 1, deco: mkHidden })
        items.push({ from: pipePos + 1, to: e - 2,      deco: mkWikiLink })
        items.push({ from: e - 2,       to: e,           deco: mkHidden })
      }
    } else if (s + 2 < e - 2) {
      items.push({ from: s,     to: s + 2, deco: mkHidden })
      items.push({ from: s + 2, to: e - 2, deco: mkWikiLink })
      items.push({ from: e - 2, to: e,     deco: mkHidden })
    }
  }

  items.sort((a, b) => a.from - b.from || a.to - b.to)

  const result: Item[] = []
  let lastTo = -Infinity
  for (const item of items) {
    if (item.from >= lastTo) {
      result.push(item)
      lastTo = Math.max(lastTo, item.to)
    }
  }
  return result
}

// ── Main builder ──────────────────────────────────────────────────────────────

function buildDecorations(view: EditorView): DecorationSet {
  const doc        = view.state.doc
  const sel        = view.state.selection.main
  const curFrom    = doc.lineAt(sel.from).number
  const curTo      = doc.lineAt(sel.to).number
  const blockRanges = findBlockRanges(doc)

  const allItems: Item[] = []

  // Add inactive block widgets
  for (const block of blockRanges) {
    const active = block.fromLine <= curTo && block.toLine >= curFrom
    if (!active) {
      allItems.push({ from: block.from, to: block.to, deco: block.widget })
    }
  }

  // Inline / heading decorations for non-blocked lines
  for (const { from: vpFrom, to: vpTo } of view.visibleRanges) {
    let pos = vpFrom
    while (pos <= vpTo) {
      const line    = doc.lineAt(pos)
      const lineNum = line.number
      const isActive = lineNum >= curFrom && lineNum <= curTo

      // Skip lines inside an inactive block
      const blocked = blockRanges.some(
        (b) =>
          b.fromLine <= lineNum &&
          b.toLine >= lineNum &&
          !(b.fromLine <= curTo && b.toLine >= curFrom),
      )

      if (!blocked) {
        const { text, from: lFrom, to: lTo } = line
        const hm = /^(#{1,6}) /.exec(text)

        if (hm) {
          const level     = hm[1].length
          const prefixEnd = lFrom + hm[0].length
          const chunk: Item[] = []

          if (!isActive)            chunk.push({ from: lFrom, to: prefixEnd, deco: mkHidden })
          if (prefixEnd <= lTo)     chunk.push({ from: prefixEnd, to: lTo, deco: mkHeadings[level - 1] })
          if (!isActive && prefixEnd < lTo) {
            chunk.push(...collectInline(prefixEnd, text.slice(hm[0].length)))
          }

          chunk.sort((a, b) => a.from - b.from || a.to - b.to)
          allItems.push(...chunk)
        } else if (!isActive) {
          allItems.push(...collectInline(lFrom, text))
        }
      }

      pos = line.to + 1
    }
  }

  allItems.sort((a, b) => a.from - b.from || a.to - b.to)

  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to, deco } of allItems) {
    builder.add(from, to, deco)
  }
  return builder.finish()
}

// ── ViewPlugin ────────────────────────────────────────────────────────────────

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = buildDecorations(view) }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

// ── Exports ───────────────────────────────────────────────────────────────────

export function createLivePreviewExtensions(onNavigate: (target: string) => void) {
  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
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

  return [livePreviewPlugin, clickHandler]
}

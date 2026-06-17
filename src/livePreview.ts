import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'

type Item = { from: number; to: number; deco: Decoration }

const mkHidden = Decoration.mark({ class: 'cm-md-hidden' })
const mkBold = Decoration.mark({ class: 'cm-md-bold' })
const mkItalic = Decoration.mark({ class: 'cm-md-italic' })
const mkCode = Decoration.mark({ class: 'cm-md-code' })
const mkStrike = Decoration.mark({ class: 'cm-md-strike' })
const mkWikiLink = Decoration.mark({ class: 'cm-md-wikilink' })
const mkHeadings = [1, 2, 3, 4, 5, 6].map((l) => Decoration.mark({ class: `cm-md-h${l}` }))

function collectInline(offset: number, text: string): Item[] {
  const items: Item[] = []

  function push(m: RegExpExecArray, openLen: number, closeLen: number, deco: Decoration) {
    const s = offset + m.index!
    const e = s + m[0].length
    const innerFrom = s + openLen
    const innerTo = e - closeLen
    if (innerFrom >= innerTo) return
    items.push({ from: s, to: innerFrom, deco: mkHidden })
    items.push({ from: innerFrom, to: innerTo, deco })
    items.push({ from: innerTo, to: e, deco: mkHidden })
  }

  for (const m of text.matchAll(/\*\*([^*\n]{1,300}?)\*\*/g)) push(m, 2, 2, mkBold)
  for (const m of text.matchAll(/(?<!\*)\*(?!\*)([^*\n]{1,300}?)(?<!\*)\*(?!\*)/g)) push(m, 1, 1, mkItalic)
  for (const m of text.matchAll(/`([^`\n]{1,300}?)`/g)) push(m, 1, 1, mkCode)
  for (const m of text.matchAll(/~~([^~\n]{1,300}?)~~/g)) push(m, 2, 2, mkStrike)

  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g)) {
    const s = offset + m.index!
    const e = s + m[0].length
    if (m[2] !== undefined) {
      const pipePos = s + m[0].lastIndexOf('|')
      if (pipePos + 1 < e - 2) {
        items.push({ from: s, to: pipePos + 1, deco: mkHidden })
        items.push({ from: pipePos + 1, to: e - 2, deco: mkWikiLink })
        items.push({ from: e - 2, to: e, deco: mkHidden })
      }
    } else if (s + 2 < e - 2) {
      items.push({ from: s, to: s + 2, deco: mkHidden })
      items.push({ from: s + 2, to: e - 2, deco: mkWikiLink })
      items.push({ from: e - 2, to: e, deco: mkHidden })
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

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const sel = view.state.selection.main
  const fromLine = view.state.doc.lineAt(sel.from).number
  const toLine = view.state.doc.lineAt(sel.to).number

  for (const { from: vpFrom, to: vpTo } of view.visibleRanges) {
    let pos = vpFrom
    while (pos <= vpTo) {
      const line = view.state.doc.lineAt(pos)
      const isActive = line.number >= fromLine && line.number <= toLine
      const { text, from: lFrom, to: lTo } = line

      const hm = /^(#{1,6}) /.exec(text)
      if (hm) {
        const level = hm[1].length
        const prefixEnd = lFrom + hm[0].length
        const all: Item[] = []

        if (!isActive) {
          all.push({ from: lFrom, to: prefixEnd, deco: mkHidden })
        }
        if (prefixEnd <= lTo) {
          all.push({ from: prefixEnd, to: lTo, deco: mkHeadings[level - 1] })
        }
        if (!isActive && prefixEnd < lTo) {
          all.push(...collectInline(prefixEnd, text.slice(hm[0].length)))
        }

        all.sort((a, b) => a.from - b.from || a.to - b.to)
        for (const { from, to, deco } of all) builder.add(from, to, deco)
      } else if (!isActive) {
        for (const { from, to, deco } of collectInline(lFrom, text)) {
          builder.add(from, to, deco)
        }
      }

      pos = lTo + 1
    }
  }

  return builder.finish()
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

export function createLivePreviewExtensions(onNavigate: (target: string) => void) {
  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!event.ctrlKey && !event.metaKey) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos === null) return false
      const line = view.state.doc.lineAt(pos)
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

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import {
  Cloud,
  ChevronDown,
  ChevronRight,
  FileDown,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  FolderOpen,
  Link2,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import './App.css'

type Note = {
  id: string
  title: string
  path: string
  content: string
  links: string[]
  updatedAt: string
  deletedAt?: string
}

type VaultState = {
  name: string
  notes: Note[]
  folders?: string[]
  importedAt: string
}

type CloudVaultResponse = {
  ok: boolean
  vault?: VaultState
  error?: string
}

type NoteTreeNode = {
  name: string
  path: string
  folders: NoteTreeNode[]
  notes: Note[]
}

type ContextMenuState = {
  x: number
  y: number
  folderPath: string
  noteId?: string
}

type DragState =
  | {
      type: 'note'
      noteId: string
    }
  | {
      type: 'folder'
      folderPath: string
    }

type RenameTarget =
  | {
      type: 'note'
      id: string
    }
  | {
      type: 'folder'
      path: string
    }

const STORAGE_KEY = 'web-obsidian:vault'
const API_HEALTH_ENDPOINT = '/api/health'
const API_VAULT_ENDPOINT = '/api/vault'
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const sampleVault: VaultState = {
  name: 'Demo Cloud Vault',
  importedAt: new Date().toISOString(),
  folders: ['Projects'],
  notes: [
    {
      id: 'welcome.md',
      title: 'Welcome',
      path: 'Welcome.md',
      updatedAt: new Date().toISOString(),
      content:
        '# Welcome\n\nThis is a Vercel-ready Obsidian-style vault. Import a local Obsidian folder, edit Markdown, resolve [[wiki links]], then save the vault to Vercel Blob.\n\nOpen [[Projects/Web Obsidian]] to see backlinks.',
      links: ['Projects/Web Obsidian'],
    },
    {
      id: 'projects/web-obsidian.md',
      title: 'Web Obsidian',
      path: 'Projects/Web Obsidian.md',
      updatedAt: new Date().toISOString(),
      content:
        '# Web Obsidian\n\nThe browser imports Markdown files from your local vault. The Vercel API stores the current vault JSON in Vercel Blob, so you do not need Supabase for the first version.\n\nBack to [[Welcome]].',
      links: ['Welcome'],
    },
  ],
}

marked.use({
  gfm: true,
  breaks: true,
})

function App() {
  const directoryInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [vault, setVault] = useState<VaultState>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) : sampleVault
  })
  const [activeId, setActiveId] = useState(vault.notes[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [cloudStatus, setCloudStatus] = useState('Local mode')
  const [isSyncing, setIsSyncing] = useState(false)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(['Projects']))
  const [previewWidth, setPreviewWidth] = useState(380)
  const [cloudReady, setCloudReady] = useState(false)
  const [cloudInitialized, setCloudInitialized] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [trashExpanded, setTrashExpanded] = useState(false)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const lastSavedCloudSignatureRef = useRef('')

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneExpiredTrash(vault)))
  }, [vault])

  useEffect(() => {
    function closeContextMenu() {
      setContextMenu(null)
    }

    window.addEventListener('click', closeContextMenu)
    window.addEventListener('keydown', closeContextMenu)
    return () => {
      window.removeEventListener('click', closeContextMenu)
      window.removeEventListener('keydown', closeContextMenu)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    async function initializeCloud() {
      try {
        const healthResponse = await fetch(API_HEALTH_ENDPOINT, { signal: controller.signal })
        const health = (await healthResponse.json()) as { storage?: string }

        if (!healthResponse.ok || health.storage !== 'blob-configured') {
          setCloudReady(false)
          setCloudStatus('Local mode')
          setCloudInitialized(true)
          return
        }

        setCloudReady(true)
        setCloudStatus('Loading cloud vault')

        const vaultResponse = await fetch(API_VAULT_ENDPOINT, { signal: controller.signal })

        if (vaultResponse.status === 404) {
          lastSavedCloudSignatureRef.current = ''
          setCloudStatus('Autosave ready')
          setCloudInitialized(true)
          return
        }

        const data = (await vaultResponse.json()) as CloudVaultResponse

        if (!vaultResponse.ok || !data.vault) {
          throw new Error(data.error || 'Cloud load failed')
        }

        const nextVault = pruneExpiredTrash(data.vault)
        const nextActiveNotes = getActiveNotes(nextVault.notes)
        setVault(nextVault)
        setActiveId(nextActiveNotes[0]?.id ?? '')
        setExpandedFolders(collectFolderPaths(buildNoteTree(nextActiveNotes, nextVault.folders)))
        lastSavedCloudSignatureRef.current = JSON.stringify(nextVault)
        setCloudStatus('Loaded. Autosave ready')
        setCloudInitialized(true)
      } catch (error) {
        if (controller.signal.aborted) return
        setCloudReady(false)
        setCloudStatus(error instanceof Error ? error.message : 'Cloud unavailable')
        setCloudInitialized(true)
      }
    }

    initializeCloud()

    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!cloudReady || !cloudInitialized) return

    const nextVault = pruneExpiredTrash(vault)
    const nextSignature = JSON.stringify(nextVault)
    if (nextSignature === lastSavedCloudSignatureRef.current) return

    setCloudStatus('Autosave pending')
    const timeoutId = window.setTimeout(async () => {
      setIsSyncing(true)
      setCloudStatus('Saving to cloud')

      try {
        const response = await fetch(API_VAULT_ENDPOINT, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: nextSignature,
        })
        const data = (await response.json()) as CloudVaultResponse

        if (!response.ok) {
          throw new Error(data.error || 'Autosave failed')
        }

        lastSavedCloudSignatureRef.current = nextSignature
        setCloudStatus('Autosaved')
      } catch (error) {
        setCloudStatus(error instanceof Error ? error.message : 'Autosave failed')
      } finally {
        setIsSyncing(false)
      }
    }, 1000)

    return () => window.clearTimeout(timeoutId)
  }, [cloudInitialized, cloudReady, vault])

  const activeNotes = useMemo(() => getActiveNotes(vault.notes), [vault.notes])
  const trashedNotes = useMemo(() => getTrashedNotes(vault.notes), [vault.notes])

  const notesByTitle = useMemo(() => {
    const map = new Map<string, Note>()
    activeNotes.forEach((note) => {
      map.set(normalizeTitle(note.title), note)
      map.set(normalizeTitle(note.path.replace(/\.md$/i, '')), note)
    })
    return map
  }, [activeNotes])

  const activeNote = activeNotes.find((note) => note.id === activeId) ?? activeNotes[0]

  const filteredNotes = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return activeNotes
    return activeNotes.filter((note) =>
      [note.title, note.path, note.content].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    )
  }, [activeNotes, query])

  const noteTree = useMemo(() => buildNoteTree(filteredNotes, vault.folders), [filteredNotes, vault.folders])

  const visibleExpandedFolders = useMemo(() => {
    if (!query.trim()) return expandedFolders
    return collectFolderPaths(noteTree)
  }, [expandedFolders, noteTree, query])

  const backlinks = useMemo(() => {
    if (!activeNote) return []
    const title = normalizeTitle(activeNote.title)
    const pathTitle = normalizeTitle(activeNote.path.replace(/\.md$/i, ''))
    return activeNotes.filter(
      (note) =>
        note.id !== activeNote.id &&
        note.links.some((link) => {
          const normalized = normalizeTitle(link)
          return normalized === title || normalized === pathTitle
        }),
    )
  }, [activeNote, activeNotes])

  const renderedMarkdown = useMemo(() => {
    if (!activeNote) return ''
    const linkedContent = activeNote.content.replace(
      /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
      (_, target: string, alias: string) => {
        const note = notesByTitle.get(normalizeTitle(target))
        const label = alias || target
        return note ? `[${label}](#note:${note.id})` : `<span class="missing-link">${label}</span>`
      },
    )
    return DOMPurify.sanitize(marked.parse(linkedContent) as string)
  }, [activeNote, notesByTitle])

  function openDirectoryPicker() {
    directoryInputRef.current?.click()
  }

  function openFilePicker() {
    fileInputRef.current?.click()
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (!files.length) return

    const markdownFiles = files.filter(
      (file) =>
        file.name.toLowerCase().endsWith('.md') &&
        !getRelativePath(file).split('/').includes('.obsidian'),
    )

    const vaultName = guessVaultName(markdownFiles[0])
    const notes = await Promise.all(
      markdownFiles.map(async (file) => {
        const path = stripVaultRoot(getRelativePath(file), vaultName)
        const content = await file.text()
        const title = path.split('/').pop()?.replace(/\.md$/i, '') || file.name
        return {
          id: path.toLowerCase(),
          title,
          path,
          content,
          links: extractWikiLinks(content),
          updatedAt: new Date(file.lastModified || Date.now()).toISOString(),
        }
      }),
    )

    const importedVault = {
      name: vaultName || 'Imported Vault',
      folders: collectFoldersFromNotes(notes),
      notes: notes.sort((a, b) => a.path.localeCompare(b.path)),
      importedAt: new Date().toISOString(),
    }

    setVault(importedVault)
    setActiveId(importedVault.notes[0]?.id ?? '')
    setExpandedFolders(collectFolderPaths(buildNoteTree(importedVault.notes, importedVault.folders)))
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Imported locally')
    event.target.value = ''
  }

  function createNote(folderPath = '') {
    const stamp = new Date()
    const parentPath = normalizeFolderPath(folderPath)
    const path = getUniqueNotePath(vault.notes, parentPath)
    const title = path.split('/').pop()?.replace(/\.md$/i, '') || 'Untitled'
    const note: Note = {
      id: path.toLowerCase(),
      title,
      path,
      content: `# ${title}\n\n`,
      links: [],
      updatedAt: stamp.toISOString(),
    }
    setVault((current) => ({
      ...current,
      folders: parentPath ? sortFolderPaths([...(current.folders ?? []), parentPath]) : current.folders,
      notes: [note, ...current.notes],
      importedAt: stamp.toISOString(),
    }))
    setActiveId(note.id)
    if (parentPath) expandFolderPath(parentPath)
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Unsaved local changes')
  }

  function createFolder(parentPath = '') {
    const basePath = normalizeFolderPath(parentPath)
    const rawPath = window.prompt('Folder name', 'New Folder')
    const normalizedInput = normalizeFolderPath(rawPath ?? '')
    const path = basePath && !normalizedInput.includes('/') ? `${basePath}/${normalizedInput}` : normalizedInput

    if (!path) return

    if ((vault.folders ?? []).some((folder) => folder.toLowerCase() === path.toLowerCase())) {
      setCloudStatus('Folder already exists')
      return
    }

    setVault((current) => ({
      ...current,
      folders: sortFolderPaths([...(current.folders ?? []), path]),
      importedAt: new Date().toISOString(),
    }))
    expandFolderPath(path)
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Folder created locally')
  }

  function startRenameNote(noteId: string) {
    const note = vault.notes.find((item) => item.id === noteId)
    if (!note) return

    const currentName = note.path.split('/').pop()?.replace(/\.md$/i, '') || note.title
    setRenameTarget({ type: 'note', id: noteId })
    setRenameDraft(currentName)
  }

  function startRenameFolder(folderPath: string) {
    const path = normalizeFolderPath(folderPath)
    if (!path) return

    setRenameTarget({ type: 'folder', path })
    setRenameDraft(path.split('/').pop() || path)
    expandFolderPath(getParentFolder(path))
  }

  function cancelRenameNote() {
    setRenameTarget(null)
    setRenameDraft('')
  }

  function commitRename(nextDraft = renameDraft) {
    if (!renameTarget) return

    if (renameTarget.type === 'folder') {
      commitRenameFolder(renameTarget.path, nextDraft)
      return
    }

    commitRenameNote(nextDraft, renameTarget.id)
  }

  function commitRenameNote(nextDraft: string, noteId: string) {
    const note = vault.notes.find((item) => item.id === noteId)
    if (!note) {
      cancelRenameNote()
      return
    }

    const nextName = normalizeMarkdownFileName(nextDraft)

    if (!nextName) {
      cancelRenameNote()
      return
    }

    const folderPath = getParentFolder(note.path)
    const nextPath = folderPath ? `${folderPath}/${nextName}.md` : `${nextName}.md`
    const nextId = nextPath.toLowerCase()

    cancelRenameNote()

    if (nextPath.toLowerCase() === note.path.toLowerCase()) return

    if (
      vault.notes.some(
        (item) => item.id !== noteId && item.path.toLowerCase() === nextPath.toLowerCase(),
      )
    ) {
      setCloudStatus('A note with that path already exists')
      return
    }

    setVault((current) => ({
      ...current,
      notes: current.notes.map((item) =>
        item.id === noteId
          ? {
              ...item,
              id: nextId,
              title: nextName,
              path: nextPath,
              updatedAt: new Date().toISOString(),
            }
          : item,
      ),
    }))

    if (activeId === noteId) setActiveId(nextId)
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Renamed locally')
  }

  function commitRenameFolder(folderPath: string, nextDraft: string) {
    const source = normalizeFolderPath(folderPath)
    const nextName = normalizeFolderPath(nextDraft)

    if (!source || !nextName || nextName.includes('/')) {
      cancelRenameNote()
      return
    }

    const parentPath = getParentFolder(source)
    const wantedPath = parentPath ? `${parentPath}/${nextName}` : nextName
    const nextFolderPath = getUniqueFolderPath(vault.folders ?? [], source, wantedPath)

    cancelRenameNote()

    if (source.toLowerCase() === nextFolderPath.toLowerCase()) return

    let nextActiveId = activeId
    const nextFolders = sortFolderPaths([
      ...(vault.folders ?? []).map((folder) => replacePathPrefix(folder, source, nextFolderPath)),
      ...collectParentFolders(nextFolderPath),
    ])
    const nextNotes = vault.notes.map((note) => {
      const nextPath = replacePathPrefix(note.path, source, nextFolderPath)
      if (nextPath === note.path) return note

      const nextNote = {
        ...note,
        id: nextPath.toLowerCase(),
        path: nextPath,
        updatedAt: new Date().toISOString(),
      }

      if (note.id === activeId) nextActiveId = nextNote.id
      return nextNote
    })

    setVault((current) => ({
      ...current,
      folders: nextFolders,
      notes: nextNotes,
    }))
    setActiveId(nextActiveId)
    expandFolderPath(nextFolderPath)
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Folder renamed locally')
  }

  function moveNoteToTrash(noteId: string) {
    const now = new Date().toISOString()
    const nextActiveId = activeNotes.find((note) => note.id !== noteId)?.id ?? ''

    setVault((current) => ({
      ...current,
      notes: current.notes.map((note) =>
        note.id === noteId
          ? {
              ...note,
              deletedAt: now,
              updatedAt: now,
            }
          : note,
      ),
    }))

    if (activeId === noteId) setActiveId(nextActiveId)
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Moved to trash')
  }

  function restoreNote(noteId: string) {
    setVault((current) => ({
      ...current,
      notes: current.notes.map((note) =>
        note.id === noteId
          ? {
              ...note,
              deletedAt: undefined,
              updatedAt: new Date().toISOString(),
            }
          : note,
      ),
    }))
    setActiveId(noteId)
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Restored locally')
  }

  function forceDeleteNote(noteId: string) {
    setVault((current) => ({
      ...current,
      notes: current.notes.filter((note) => note.id !== noteId),
    }))
    if (activeId === noteId) setActiveId(activeNotes[0]?.id ?? '')
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Permanently deleted locally')
  }

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  function expandFolderPath(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current)
      const parts = path.split('/').filter(Boolean)

      parts.forEach((_, index) => {
        next.add(parts.slice(0, index + 1).join('/'))
      })

      return next
    })
  }

  function openContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    folderPath = '',
    noteId?: string,
  ) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      folderPath,
      noteId,
    })
  }

  function runContextAction(action: () => void) {
    action()
    setContextMenu(null)
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!dragState) return
    event.preventDefault()
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>, targetFolderPath = '') {
    event.preventDefault()
    event.stopPropagation()

    if (!dragState) return

    if (dragState.type === 'note') {
      moveNoteToFolder(dragState.noteId, targetFolderPath)
    } else {
      moveFolderToFolder(dragState.folderPath, targetFolderPath)
    }

    setDragState(null)
  }

  function moveNoteToFolder(noteId: string, targetFolderPath: string) {
    const note = vault.notes.find((item) => item.id === noteId)
    if (!note) return

    const target = normalizeFolderPath(targetFolderPath)
    const fileName = note.path.split('/').pop() || `${note.title}.md`
    const currentParent = getParentFolder(note.path)
    if (target === currentParent) return

    const nextPath = getUniqueMovedNotePath(vault.notes, noteId, target, fileName)
    const nextTitle = nextPath.split('/').pop()?.replace(/\.md$/i, '') || note.title
    const nextId = nextPath.toLowerCase()

    setVault((current) => ({
      ...current,
      folders: target ? sortFolderPaths([...(current.folders ?? []), target]) : current.folders,
      notes: current.notes.map((item) =>
        item.id === noteId
          ? {
              ...item,
              id: nextId,
              title: nextTitle,
              path: nextPath,
              updatedAt: new Date().toISOString(),
            }
          : item,
      ),
    }))

    if (activeId === noteId) setActiveId(nextId)
    if (target) expandFolderPath(target)
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Moved locally')
  }

  function moveFolderToFolder(sourceFolderPath: string, targetFolderPath: string) {
    const source = normalizeFolderPath(sourceFolderPath)
    const target = normalizeFolderPath(targetFolderPath)

    if (!source || source === target || target.startsWith(`${source}/`)) {
      setCloudStatus('Cannot move folder there')
      return
    }

    const folderName = source.split('/').pop() || source
    const wantedPath = target ? `${target}/${folderName}` : folderName
    const existingFolders = vault.folders ?? []
    const nextFolderPath = getUniqueFolderPath(existingFolders, source, wantedPath)

    if (nextFolderPath === source) return

    let nextActiveId = activeId
    const movedFolders = (vault.folders ?? []).map((folder) =>
      replacePathPrefix(folder, source, nextFolderPath),
    )
    const nextFolders = sortFolderPaths([
      ...movedFolders,
      ...collectParentFolders(nextFolderPath),
      ...(target ? collectParentFolders(target) : []),
    ])
    const nextNotes = vault.notes.map((note) => {
      const nextPath = replacePathPrefix(note.path, source, nextFolderPath)
      if (nextPath === note.path) return note

      const nextNote = {
        ...note,
        id: nextPath.toLowerCase(),
        path: nextPath,
        updatedAt: new Date().toISOString(),
      }

      if (note.id === activeId) nextActiveId = nextNote.id
      return nextNote
    })

    setVault((current) => ({
      ...current,
      folders: nextFolders,
      notes: nextNotes,
    }))

    setActiveId(nextActiveId)
    expandFolderPath(nextFolderPath)
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Moved locally')
  }

  function updateActiveNote(content: string) {
    if (!activeNote) return
    setVault((current) => ({
      ...current,
      notes: current.notes.map((note) =>
        note.id === activeNote.id
          ? {
              ...note,
              content,
              links: extractWikiLinks(content),
              updatedAt: new Date().toISOString(),
            }
          : note,
      ),
    }))
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Unsaved local changes')
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(vault, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${vault.name.replace(/\s+/g, '-').toLowerCase()}-vault.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function startPreviewResize(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = previewWidth

    function handleMouseMove(moveEvent: MouseEvent) {
      const nextWidth = startWidth - (moveEvent.clientX - startX)
      setPreviewWidth(clamp(nextWidth, 300, 680))
    }

    function handleMouseUp() {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  function handlePreviewClick(event: ReactMouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    const anchor = target.closest('a')
    const href = anchor?.getAttribute('href')
    if (!href?.startsWith('#note:')) return
    event.preventDefault()
    setActiveId(href.replace('#note:', ''))
  }

  return (
    <main
      className="app-shell"
      style={
        {
          '--preview-width': `${previewWidth}px`,
        } as CSSProperties
      }
    >
      <aside className="sidebar">
        <div className="brand">
          <Cloud size={28} aria-hidden="true" />
          <div>
            <strong>Cloud Vault</strong>
            <span>{vault.name}</span>
          </div>
        </div>

        <div className="toolbar" aria-label="Vault actions">
          <button type="button" onClick={openDirectoryPicker} title="Import Obsidian folder">
            <FolderOpen size={18} aria-hidden="true" />
            Import folder
          </button>
          <button type="button" onClick={openFilePicker} title="Import Markdown files">
            <UploadCloud size={18} aria-hidden="true" />
            Import files
          </button>
          <button type="button" onClick={downloadJson} title="Export JSON">
            <FileDown size={18} aria-hidden="true" />
            Export
          </button>
        </div>

        <input
          ref={(node) => {
            directoryInputRef.current = node
            node?.setAttribute('webkitdirectory', '')
            node?.setAttribute('directory', '')
          }}
          className="hidden-input"
          type="file"
          multiple
          onChange={importFiles}
          aria-hidden="true"
        />
        <input
          ref={fileInputRef}
          className="hidden-input"
          type="file"
          multiple
          accept=".md,text/markdown,text/plain"
          onChange={importFiles}
          aria-hidden="true"
        />

        <label className="search">
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, path, or content"
          />
        </label>

        <div className="stats">
          <span>{activeNotes.length} notes</span>
          <span>{countLinks(activeNotes)} links</span>
          <span>{isSyncing ? 'Saving to cloud' : cloudStatus}</span>
        </div>

        <div className="file-actions" aria-label="File explorer actions">
          <button type="button" onClick={() => createNote()} title="New Markdown file">
            <FilePlus size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => createFolder()} title="New folder">
            <FolderPlus size={16} aria-hidden="true" />
          </button>
        </div>

        <nav
          className="note-list"
          aria-label="Notes"
          onContextMenu={(event) => openContextMenu(event)}
          onDragOver={handleDragOver}
          onDrop={(event) => handleDrop(event)}
        >
          {noteTree.folders.map((folder) =>
            renderFolderNode(folder, {
              activeId: activeNote?.id ?? '',
              expandedFolders: visibleExpandedFolders,
              level: 0,
              onSelectNote: setActiveId,
              onToggleFolder: toggleFolder,
              onTrashNote: moveNoteToTrash,
              onRenameNote: startRenameNote,
              onContextMenu: openContextMenu,
              onDragStart: setDragState,
              onDragOver: handleDragOver,
              onDrop: handleDrop,
              onDragEnd: () => setDragState(null),
              renameTarget,
              renameDraft,
              onRenameDraftChange: setRenameDraft,
              onCommitRename: commitRename,
              onCancelRename: cancelRenameNote,
              onRenameFolder: startRenameFolder,
            }),
          )}
          {noteTree.notes.map((note) =>
            renderNoteNode(note, {
              activeId: activeNote?.id ?? '',
              level: 0,
              onSelectNote: setActiveId,
              onTrashNote: moveNoteToTrash,
              onRenameNote: startRenameNote,
              onContextMenu: openContextMenu,
              onDragStart: setDragState,
              onDragEnd: () => setDragState(null),
              renameTarget,
              renameDraft,
              onRenameDraftChange: setRenameDraft,
              onCommitRename: commitRename,
              onCancelRename: cancelRenameNote,
            }),
          )}
        </nav>

        <section className="trash-section" aria-label="Trash">
          <button
            type="button"
            className="trash-toggle"
            onClick={() => setTrashExpanded((current) => !current)}
            aria-expanded={trashExpanded}
          >
            {trashExpanded ? (
              <ChevronDown size={15} aria-hidden="true" />
            ) : (
              <ChevronRight size={15} aria-hidden="true" />
            )}
            <Trash2 size={15} aria-hidden="true" />
            <strong>Trash</strong>
            <span>{trashedNotes.length}</span>
          </button>
          {trashExpanded && trashedNotes.length ? (
            <div className="trash-list">
              {trashedNotes.map((note) => (
                <div className="trash-row" key={note.id}>
                  <button type="button" onClick={() => restoreNote(note.id)} title="Restore note">
                    <RotateCcw size={14} aria-hidden="true" />
                  </button>
                  <span>
                    <strong>{note.title}</strong>
                    <small>{getTrashLabel(note)}</small>
                  </span>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => forceDeleteNote(note.id)}
                    title="Delete permanently"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {trashExpanded && !trashedNotes.length ? (
            <p>Trash is empty</p>
          ) : null}
        </section>
      </aside>

      {contextMenu ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => runContextAction(() => createNote(contextMenu.folderPath))}
          >
            <FilePlus size={15} aria-hidden="true" />
            New note
          </button>
          <button
            type="button"
            onClick={() => runContextAction(() => createFolder(contextMenu.folderPath))}
          >
            <FolderPlus size={15} aria-hidden="true" />
            New folder
          </button>
          {contextMenu.folderPath ? (
            <button
              type="button"
              onClick={() => runContextAction(() => startRenameFolder(contextMenu.folderPath))}
            >
              <Pencil size={15} aria-hidden="true" />
              Rename folder
            </button>
          ) : null}
          {contextMenu.noteId ? (
            <>
              <hr />
              <button
                type="button"
                onClick={() => runContextAction(() => startRenameNote(contextMenu.noteId ?? ''))}
              >
                <Pencil size={15} aria-hidden="true" />
                Rename
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => runContextAction(() => moveNoteToTrash(contextMenu.noteId ?? ''))}
              >
                <Trash2 size={15} aria-hidden="true" />
                Move to trash
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <section className="editor-pane">
        {activeNote ? (
          <>
            <header className="note-header">
              <div>
                {isRenamingNote(renameTarget, activeNote.id) ? (
                  <>
                    <p>{getParentFolder(activeNote.path) || 'Root'}</p>
                    <input
                      className="title-rename-input"
                      value={renameDraft}
                      autoFocus
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={(event) => commitRename(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          commitRename(event.currentTarget.value)
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelRenameNote()
                        }
                      }}
                    />
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="path-edit-button"
                      onClick={() => startRenameNote(activeNote.id)}
                      title="Rename Markdown file"
                    >
                      {activeNote.path}
                    </button>
                    <button
                      type="button"
                      className="title-edit-button"
                      onClick={() => startRenameNote(activeNote.id)}
                      title="Rename Markdown file"
                    >
                      {activeNote.title}
                    </button>
                  </>
                )}
              </div>
              <span>{new Date(activeNote.updatedAt).toLocaleString()}</span>
            </header>
            <textarea
              value={activeNote.content}
              onChange={(event) => updateActiveNote(event.target.value)}
              spellCheck="false"
              aria-label="Markdown editor"
            />
          </>
        ) : (
          <div className="empty-state">Import a vault or create the first note.</div>
        )}
      </section>

      <div
        className="resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Markdown preview"
        onMouseDown={startPreviewResize}
      />

      <aside className="preview-pane">
        <div className="preview-scroll">
          <section
            className="markdown-preview"
            onClick={handlePreviewClick}
            dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
          />

          <section className="relations">
            <h2>
              <Link2 size={18} aria-hidden="true" />
              Links
            </h2>
            <div className="relation-group">
              <strong>Outgoing</strong>
              {activeNote?.links.length ? (
                activeNote.links.map((link) => (
                  <button
                    type="button"
                    key={link}
                    onClick={() => {
                      const note = notesByTitle.get(normalizeTitle(link))
                      if (note) setActiveId(note.id)
                    }}
                    className={notesByTitle.has(normalizeTitle(link)) ? '' : 'missing'}
                  >
                    {link}
                  </button>
                ))
              ) : (
                <span>No links</span>
              )}
            </div>
            <div className="relation-group">
              <strong>Backlinks</strong>
              {backlinks.length ? (
                backlinks.map((note) => (
                  <button type="button" key={note.id} onClick={() => setActiveId(note.id)}>
                    {note.title}
                  </button>
                ))
              ) : (
                <span>No backlinks</span>
              )}
            </div>
          </section>
        </div>
      </aside>
    </main>
  )
}

function getRelativePath(file: File) {
  return ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replace(
    /\\/g,
    '/',
  )
}

function guessVaultName(file?: File) {
  if (!file) return ''
  const path = getRelativePath(file)
  return path.includes('/') ? path.split('/')[0] : ''
}

function stripVaultRoot(path: string, vaultName: string) {
  if (!vaultName) return path
  return path.startsWith(`${vaultName}/`) ? path.slice(vaultName.length + 1) : path
}

function getParentFolder(path: string) {
  const segments = path.split('/').filter(Boolean)
  segments.pop()
  return segments.join('/')
}

function normalizeFolderPath(path: string) {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')
}

function normalizeMarkdownFileName(name: string) {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.md$/i, '')
    .trim()
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120) ?? ''
}

function extractWikiLinks(content: string) {
  return Array.from(content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g))
    .map((match) => match[1].trim())
    .filter(Boolean)
}

function normalizeTitle(value: string) {
  return value.replace(/\.md$/i, '').trim().toLowerCase()
}

function countLinks(notes: Note[]) {
  return notes.reduce((total, note) => total + note.links.length, 0)
}

function getActiveNotes(notes: Note[]) {
  return notes.filter((note) => !note.deletedAt)
}

function getTrashedNotes(notes: Note[]) {
  const now = Date.now()
  return notes.filter((note) => note.deletedAt && now - Date.parse(note.deletedAt) < TRASH_RETENTION_MS)
}

function pruneExpiredTrash(vault: VaultState): VaultState {
  const now = Date.now()
  return {
    ...vault,
    notes: vault.notes.filter((note) => !note.deletedAt || now - Date.parse(note.deletedAt) < TRASH_RETENTION_MS),
  }
}

function getTrashLabel(note: Note) {
  if (!note.deletedAt) return note.path

  const deletedAt = Date.parse(note.deletedAt)
  const remainingMs = Math.max(TRASH_RETENTION_MS - (Date.now() - deletedAt), 0)
  const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000))
  return `${remainingDays} day${remainingDays === 1 ? '' : 's'} left - ${note.path}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getUniqueNotePath(notes: Note[], folderPath: string) {
  const existingPaths = new Set(notes.map((note) => note.path.toLowerCase()))

  for (let index = 1; index < 10000; index += 1) {
    const title = index === 1 ? 'Untitled' : `Untitled ${index}`
    const path = folderPath ? `${folderPath}/${title}.md` : `${title}.md`

    if (!existingPaths.has(path.toLowerCase())) return path
  }

  return folderPath ? `${folderPath}/Untitled ${Date.now()}.md` : `Untitled ${Date.now()}.md`
}

function getUniqueMovedNotePath(
  notes: Note[],
  movingNoteId: string,
  folderPath: string,
  fileName: string,
) {
  const existingPaths = new Set(
    notes
      .filter((note) => note.id !== movingNoteId)
      .map((note) => note.path.toLowerCase()),
  )
  const baseName = fileName.replace(/\.md$/i, '')

  for (let index = 1; index < 10000; index += 1) {
    const nextName = index === 1 ? baseName : `${baseName} ${index}`
    const path = folderPath ? `${folderPath}/${nextName}.md` : `${nextName}.md`

    if (!existingPaths.has(path.toLowerCase())) return path
  }

  return folderPath ? `${folderPath}/${baseName} ${Date.now()}.md` : `${baseName} ${Date.now()}.md`
}

function getUniqueFolderPath(folders: string[], movingFolderPath: string, wantedPath: string) {
  const existingFolders = new Set(
    folders
      .filter(
        (folder) =>
          folder.toLowerCase() !== movingFolderPath.toLowerCase() &&
          !folder.toLowerCase().startsWith(`${movingFolderPath.toLowerCase()}/`),
      )
      .map((folder) => folder.toLowerCase()),
  )
  const parent = getParentFolder(wantedPath)
  const baseName = wantedPath.split('/').pop() || wantedPath

  for (let index = 1; index < 10000; index += 1) {
    const nextName = index === 1 ? baseName : `${baseName} ${index}`
    const path = parent ? `${parent}/${nextName}` : nextName

    if (!existingFolders.has(path.toLowerCase())) return path
  }

  return parent ? `${parent}/${baseName} ${Date.now()}` : `${baseName} ${Date.now()}`
}

function replacePathPrefix(path: string, sourcePrefix: string, nextPrefix: string) {
  if (path === sourcePrefix) return nextPrefix
  if (path.startsWith(`${sourcePrefix}/`)) return `${nextPrefix}${path.slice(sourcePrefix.length)}`
  return path
}

function collectParentFolders(path: string) {
  const parts = normalizeFolderPath(path).split('/').filter(Boolean)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

function collectFoldersFromNotes(notes: Note[]) {
  const folders = new Set<string>()

  notes.forEach((note) => {
    const parent = getParentFolder(note.path)
    const parts = parent.split('/').filter(Boolean)

    parts.forEach((_, index) => {
      folders.add(parts.slice(0, index + 1).join('/'))
    })
  })

  return sortFolderPaths(Array.from(folders))
}

function sortFolderPaths(paths: string[]) {
  return Array.from(new Set(paths.map(normalizeFolderPath).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  )
}

function buildNoteTree(notes: Note[], folders: string[] = []): NoteTreeNode {
  const root: NoteTreeNode = {
    name: '',
    path: '',
    folders: [],
    notes: [],
  }

  folders.forEach((folder) => {
    addFolderToTree(root, folder)
  })

  notes.forEach((note) => {
    const segments = note.path.split('/').filter(Boolean)
    const fileName = segments.pop()

    if (!fileName) return

    const current = addFolderToTree(root, segments.join('/'))
    current.notes.push(note)
  })

  sortTree(root)
  return root
}

function addFolderToTree(root: NoteTreeNode, path: string) {
  const segments = normalizeFolderPath(path).split('/').filter(Boolean)
  let current = root

  segments.forEach((segment) => {
    const folderPath = current.path ? `${current.path}/${segment}` : segment
    let folder = current.folders.find((item) => item.path.toLowerCase() === folderPath.toLowerCase())

    if (!folder) {
      folder = {
        name: segment,
        path: folderPath,
        folders: [],
        notes: [],
      }
      current.folders.push(folder)
    }

    current = folder
  })

  return current
}

function sortTree(node: NoteTreeNode) {
  node.folders.sort((a, b) => a.name.localeCompare(b.name))
  node.notes.sort((a, b) => a.title.localeCompare(b.title))
  node.folders.forEach(sortTree)
}

function collectFolderPaths(node: NoteTreeNode) {
  const paths = new Set<string>()

  function visit(folder: NoteTreeNode) {
    folder.folders.forEach((child) => {
      paths.add(child.path)
      visit(child)
    })
  }

  visit(node)
  return paths
}

function renderFolderNode(
  folder: NoteTreeNode,
  options: {
    activeId: string
    expandedFolders: Set<string>
    level: number
    onSelectNote: (id: string) => void
    onToggleFolder: (path: string) => void
    onTrashNote: (id: string) => void
    onRenameNote: (id: string) => void
    onContextMenu: (event: ReactMouseEvent<HTMLElement>, folderPath?: string, noteId?: string) => void
    onDragStart: (state: DragState) => void
    onDragOver: (event: ReactDragEvent<HTMLElement>) => void
    onDrop: (event: ReactDragEvent<HTMLElement>, targetFolderPath?: string) => void
    onDragEnd: () => void
    renameTarget: RenameTarget | null
    renameDraft: string
    onRenameDraftChange: (value: string) => void
    onCommitRename: (value?: string) => void
    onCancelRename: () => void
    onRenameFolder: (path: string) => void
  },
) {
  const isExpanded = options.expandedFolders.has(folder.path)
  const isRenaming = isRenamingFolder(options.renameTarget, folder.path)

  return (
    <div className="tree-node" key={folder.path}>
      <div className="folder-row-wrap">
        {isRenaming ? (
          <div className="folder-row editing" style={getTreeRowStyle(options.level)}>
            <FolderOpen size={16} aria-hidden="true" />
            <input
              value={options.renameDraft}
              autoFocus
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => options.onRenameDraftChange(event.target.value)}
              onBlur={(event) => options.onCommitRename(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  options.onCommitRename(event.currentTarget.value)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  options.onCancelRename()
                }
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className="folder-row"
            style={getTreeRowStyle(options.level)}
            onClick={() => options.onToggleFolder(folder.path)}
            onContextMenu={(event) => options.onContextMenu(event, folder.path)}
            draggable
            onDragStart={(event) => {
              event.stopPropagation()
              options.onDragStart({ type: 'folder', folderPath: folder.path })
            }}
            onDragOver={options.onDragOver}
            onDrop={(event) => options.onDrop(event, folder.path)}
            onDragEnd={options.onDragEnd}
            aria-expanded={isExpanded}
          >
            {isExpanded ? (
              <ChevronDown size={15} aria-hidden="true" />
            ) : (
              <ChevronRight size={15} aria-hidden="true" />
            )}
            {isExpanded ? (
              <FolderOpen size={16} aria-hidden="true" />
            ) : (
              <Folder size={16} aria-hidden="true" />
            )}
            <span>{folder.name}</span>
          </button>
        )}
        {!isRenaming ? (
          <button
            type="button"
            className="folder-action-button"
            onClick={() => options.onRenameFolder(folder.path)}
            title="Rename folder"
          >
            <Pencil size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {isExpanded ? (
        <div className="tree-children" style={{ '--tree-level': options.level } as CSSProperties}>
          {folder.folders.map((child) =>
            renderFolderNode(child, {
              ...options,
              level: options.level + 1,
            }),
          )}
          {folder.notes.map((note) =>
            renderNoteNode(note, {
              activeId: options.activeId,
              level: options.level + 1,
              onSelectNote: options.onSelectNote,
              onTrashNote: options.onTrashNote,
              onRenameNote: options.onRenameNote,
              onContextMenu: options.onContextMenu,
              onDragStart: options.onDragStart,
              onDragEnd: options.onDragEnd,
              renameTarget: options.renameTarget,
              renameDraft: options.renameDraft,
              onRenameDraftChange: options.onRenameDraftChange,
              onCommitRename: options.onCommitRename,
              onCancelRename: options.onCancelRename,
            }),
          )}
        </div>
      ) : null}
    </div>
  )
}

function renderNoteNode(
  note: Note,
  options: {
    activeId: string
    level: number
    onSelectNote: (id: string) => void
    onTrashNote: (id: string) => void
    onRenameNote: (id: string) => void
    onContextMenu: (event: ReactMouseEvent<HTMLElement>, folderPath?: string, noteId?: string) => void
    onDragStart: (state: DragState) => void
    onDragEnd: () => void
    renameTarget: RenameTarget | null
    renameDraft: string
    onRenameDraftChange: (value: string) => void
    onCommitRename: (value?: string) => void
    onCancelRename: () => void
  },
) {
  const parentPath = getParentFolder(note.path)
  const isRenaming = isRenamingNote(options.renameTarget, note.id)

  return (
    <div
      className={note.id === options.activeId ? 'note-row-wrap active' : 'note-row-wrap'}
      key={note.id}
      style={getTreeRowStyle(options.level)}
      onContextMenu={(event) => options.onContextMenu(event, parentPath, note.id)}
      draggable={!isRenaming}
      onDragStart={(event) => {
        event.stopPropagation()
        options.onDragStart({ type: 'note', noteId: note.id })
      }}
      onDragEnd={options.onDragEnd}
    >
      {isRenaming ? (
        <div className="note-row editing">
          <FileText size={16} aria-hidden="true" />
          <input
            value={options.renameDraft}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) => options.onRenameDraftChange(event.target.value)}
            onBlur={(event) => options.onCommitRename(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                options.onCommitRename(event.currentTarget.value)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                options.onCancelRename()
              }
            }}
          />
        </div>
      ) : (
        <button type="button" className="note-row" onClick={() => options.onSelectNote(note.id)}>
          <FileText size={16} aria-hidden="true" />
          <span>
            <strong>{note.title}</strong>
            <small>{note.path}</small>
          </span>
        </button>
      )}
      <button
        type="button"
        className="note-action-button"
        onClick={() => options.onRenameNote(note.id)}
        title="Rename Markdown file"
      >
        <Pencil size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="note-action-button danger"
        onClick={() => options.onTrashNote(note.id)}
        title="Move to trash"
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

function getTreeRowStyle(level: number) {
  return {
    '--tree-level': level,
    '--tree-padding-left': `${10 + level * 16}px`,
    '--tree-line-left': `${17 + Math.max(level - 1, 0) * 16}px`,
    '--tree-line-opacity': level > 0 ? 1 : 0,
  } as CSSProperties
}

function isRenamingNote(target: RenameTarget | null, noteId: string) {
  return target?.type === 'note' && target.id === noteId
}

function isRenamingFolder(target: RenameTarget | null, folderPath: string) {
  return target?.type === 'folder' && target.path.toLowerCase() === folderPath.toLowerCase()
}

export default App

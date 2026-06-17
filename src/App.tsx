import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import {
  Cloud,
  ChevronDown,
  ChevronRight,
  FileDown,
  FileText,
  Folder,
  FolderPlus,
  FolderOpen,
  Link2,
  Pencil,
  Plus,
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
  const lastSavedCloudSignatureRef = useRef('')

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneExpiredTrash(vault)))
  }, [vault])

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

  function createNote() {
    const stamp = new Date()
    const title = `Untitled ${vault.notes.length + 1}`
    const note: Note = {
      id: `${title.toLowerCase().replace(/\s+/g, '-')}.md`,
      title,
      path: `${title}.md`,
      content: `# ${title}\n\n`,
      links: [],
      updatedAt: stamp.toISOString(),
    }
    setVault((current) => ({
      ...current,
      notes: [note, ...current.notes],
      importedAt: stamp.toISOString(),
    }))
    setActiveId(note.id)
    setCloudStatus(cloudReady ? 'Autosave pending' : 'Unsaved local changes')
  }

  function createFolder() {
    const rawPath = window.prompt('Folder path', 'New Folder')
    const path = normalizeFolderPath(rawPath ?? '')

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

  function renameNote(noteId: string) {
    const note = vault.notes.find((item) => item.id === noteId)
    if (!note) return

    const currentName = note.path.split('/').pop()?.replace(/\.md$/i, '') || note.title
    const nextName = normalizeMarkdownFileName(window.prompt('Rename Markdown file', currentName) ?? '')

    if (!nextName) return

    const folderPath = getParentFolder(note.path)
    const nextPath = folderPath ? `${folderPath}/${nextName}.md` : `${nextName}.md`
    const nextId = nextPath.toLowerCase()

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
          <button type="button" onClick={createNote} title="Create note">
            <Plus size={18} aria-hidden="true" />
            New
          </button>
          <button type="button" onClick={createFolder} title="Create folder">
            <FolderPlus size={18} aria-hidden="true" />
            Folder
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

        <nav className="note-list" aria-label="Notes">
          {noteTree.folders.map((folder) =>
            renderFolderNode(folder, {
              activeId: activeNote?.id ?? '',
              expandedFolders: visibleExpandedFolders,
              level: 0,
              onSelectNote: setActiveId,
              onToggleFolder: toggleFolder,
              onTrashNote: moveNoteToTrash,
              onRenameNote: renameNote,
            }),
          )}
          {noteTree.notes.map((note) =>
            renderNoteNode(note, {
              activeId: activeNote?.id ?? '',
              level: 0,
              onSelectNote: setActiveId,
              onTrashNote: moveNoteToTrash,
              onRenameNote: renameNote,
            }),
          )}
        </nav>

        <section className="trash-panel" aria-label="Trash">
          <h2>
            <Trash2 size={15} aria-hidden="true" />
            Trash
            <span>{trashedNotes.length}</span>
          </h2>
          {trashedNotes.length ? (
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
          ) : (
            <p>Trash is empty</p>
          )}
        </section>
      </aside>

      <section className="editor-pane">
        {activeNote ? (
          <>
            <header className="note-header">
              <div>
                <p>{activeNote.path}</p>
                <h1>{activeNote.title}</h1>
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
  },
) {
  const isExpanded = options.expandedFolders.has(folder.path)

  return (
    <div className="tree-node" key={folder.path}>
      <button
        type="button"
        className="folder-row"
        style={{ '--tree-level': options.level } as CSSProperties}
        onClick={() => options.onToggleFolder(folder.path)}
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
  },
) {
  return (
    <div
      className={note.id === options.activeId ? 'note-row-wrap active' : 'note-row-wrap'}
      key={note.id}
      style={{ '--tree-level': options.level } as CSSProperties}
    >
      <button type="button" className="note-row" onClick={() => options.onSelectNote(note.id)}>
        <FileText size={16} aria-hidden="true" />
        <span>
          <strong>{note.title}</strong>
          <small>{note.path}</small>
        </span>
      </button>
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

export default App

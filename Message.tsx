import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useData } from '@jaspers-ai/sdk'
import { numberCitations, numberKey, sourceTitle, type Citation } from './citations'
import { CiteMark, Markdown, type CiteLookup } from './MarkdownView'
import { answerText, type AnalystMessage, type Message, type Step } from './room'

// One message in the thread, reading its own live value, so an analyst's progress re-renders its row
// and nothing else. An answer's tool calls sit where the analyst made them: the text is cut at each
// step's offset, and the chips go between the pieces. Its sources are listed under it, folded until
// opened, each a link to the filing on sec.gov that opens on the quoted words. Once it is in, the copy
// icon under its text, above the sources, puts the answer and its sources on the clipboard.

interface Props {
  room: string
  seq: number
  names: Record<string, string>
  colors: Record<string, string | null>
  onLink: (href: string) => void
  onFile: (path: string) => void
  /** Resolves true once the text is on the clipboard; a failure is the room's to show. */
  onCopy: (text: string) => Promise<boolean>
}

export function MessageRow({ room, seq, names, colors, onLink, onFile, onCopy }: Props): ReactElement | null {
  const message = useData(`live/rooms/${room}/m/${seq}`) as Message | undefined
  const text = message?.role === 'analyst' ? message.text : ''
  const citations = message?.role === 'analyst' ? message.citations : undefined
  // Numbered from the text, as the runner numbers them, so a marker shows before the server has answered.
  const cite = useMemo<CiteLookup>(() => {
    const numbered = numberCitations(text)
    return {
      numbers: new Map(numbered.map((c) => [numberKey(c.attrs) ?? '', c.n])),
      resolved: new Map((citations ?? []).map((c) => [c.n, c])),
    }
  }, [text, citations])
  const copy = useMemo(() => (message?.role === 'analyst' ? answerText(message) : ''), [message])
  if (!message) return null
  if (message.role === 'user') {
    return (
      <div className="rs-msg rs-you">
        <div className="rs-meta">
          <span className="rs-name">You</span>
          <span className="rs-muted">via Jaspers → {message.to.map((id) => names[id] ?? id).join(', ')}</span>
        </div>
        <div className="rs-plain">{message.text}</div>
      </div>
    )
  }
  return (
    <div className="rs-msg">
      <div className="rs-meta">
        <span className="rs-swatch" style={{ background: message.color ?? colors[message.analyst] ?? '#737373' }} aria-hidden />
        <span className="rs-name">{message.name}</span>
        <span className={message.status === 'error' ? 'rs-error' : 'rs-muted'}>{statusText(message)}</span>
      </div>
      {body(message, onLink, cite)}
      {copy && <CopyButton text={copy} onCopy={onCopy} />}
      {cite.numbers.size > 0 && <Sources message={message} cite={cite} onLink={onLink} />}
      {message.files.length > 0 && (
        <div className="rs-files">
          {message.files.map((file) => (
            <button key={file.path} type="button" className="rs-file" onClick={() => onFile(file.path)} title={file.path}>
              {file.path.slice(file.path.lastIndexOf('/') + 1)}
              <span className="rs-muted"> {size(file.size)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function body(message: AnalystMessage, onLink: (href: string) => void, cite: CiteLookup): ReactNode[] {
  const parts: ReactNode[] = []
  const offsets = [...new Set(message.steps.map((s) => s.at))].sort((a, b) => a - b)
  let at = 0
  for (const offset of offsets) {
    const piece = message.text.slice(at, offset)
    if (piece.trim()) parts.push(<Markdown key={`t${at}`} source={piece} onLink={onLink} cite={cite} />)
    parts.push(<Steps key={`s${offset}`} steps={message.steps.filter((s) => s.at === offset)} />)
    at = offset
  }
  const rest = message.text.slice(at)
  if (rest.trim()) parts.push(<Markdown key={`t${at}`} source={rest} onLink={onLink} cite={cite} />)
  if (message.status === 'queued') parts.push(<p key="queued" className="rs-muted">Waiting to start.</p>)
  if (message.status === 'working' && message.steps.length === 0 && !message.text) parts.push(<p key="start" className="rs-muted">Reading the question…</p>)
  if (message.error && message.status !== 'done') {
    parts.push(
      <p key="error" className={message.status === 'error' ? 'rs-error' : 'rs-muted'}>
        {message.status === 'error' ? `Error: ${message.error}` : `Stopped: ${message.error}`}
      </p>,
    )
  }
  return parts
}

/**
 * The answer's sources, folded to one line until opened: how many, and what the audit found. Open, one
 * line each: the marker, what the filing is, the quoted words, and the verdict. The markers in the
 * answer link to the same pages, so the list is there to check, not to read every time.
 */
function Sources({ message, cite, onLink }: { message: AnalystMessage; cite: CiteLookup; onLink: (href: string) => void }): ReactElement {
  const numbered = numberCitations(message.text)
  const checking = message.status === 'working' || (message.status === 'done' && (message.citations ?? []).length === 0)
  const audit = message.audit
  return (
    <details className="rs-sources">
      <summary className="rs-sources-head">
        <span>Sources</span>
        <span className="rs-muted"> · {numbered.length}</span>
        {audit && (audit.uncited > 0 || audit.unverified > 0) && (
          <span className="rs-muted">
            {' · '}
            {[audit.uncited > 0 ? `${audit.uncited} uncited` : '', audit.unverified > 0 ? `${audit.unverified} unverified` : ''].filter(Boolean).join(', ')}
            {audit.repaired ? ' after repair' : ''}
          </span>
        )}
      </summary>
      {numbered.map((c) => {
        const citation: Citation | undefined = cite.resolved.get(c.n)
        return (
          <div key={c.n} className="rs-source">
            <CiteMark n={c.n} citation={citation} onLink={onLink} />
            <div className="rs-source-body">
              <span className="rs-source-title">{sourceTitle(c, citation)}</span>
              {c.quote && <span className="rs-source-quote">“{c.quote}”</span>}
              <span className={`rs-source-state ${citation?.verified === true ? 'ok' : citation?.verified === false ? 'bad' : ''}`}>
                {citation?.verified === true ? 'verified' : citation?.verified === false ? 'quote not found in the source' : checking ? 'checking…' : 'unchecked'}
              </span>
            </div>
          </div>
        )
      })}
    </details>
  )
}

/** The copy icon under an answer's text, a check for a moment once the clipboard has it. */
function CopyButton({ text, onCopy }: { text: string; onCopy: (text: string) => Promise<boolean> }): ReactElement {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const label = copied ? 'Copied' : 'Copy the answer and its sources'
  return (
    <button type="button" className="rs-copy" aria-label={label} title={label} onClick={() => void onCopy(text).then(setCopied)}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        {copied ? (
          <path d="M2.75 8.25l3.5 3.5 7-7.5" />
        ) : (
          <>
            <rect x="5.25" y="5.25" width="8.5" height="8.5" />
            <path d="M10.75 5.25v-3h-8.5v8.5h3" />
          </>
        )}
      </svg>
    </button>
  )
}

function Steps({ steps }: { steps: Step[] }): ReactElement {
  return (
    <div className="rs-steps">
      {steps.map((step, i) => (
        <details key={i} className={`rs-step${step.isError ? ' rs-step-error' : ''}`}>
          <summary>
            <code>{step.tool}</code>
            <span className="rs-muted"> {preview(step.args)}</span>
            <span className="rs-muted"> · {step.summary ?? 'running…'}</span>
          </summary>
          <pre>{step.args}</pre>
        </details>
      ))}
    </div>
  )
}

function statusText(message: AnalystMessage): string {
  switch (message.status) {
    case 'queued':
      return 'queued'
    case 'working':
      return `working · turn ${message.turns + 1}`
    case 'done':
      return message.endedAt ? time(message.endedAt) : 'done'
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'error'
  }
}

/** The arguments' values, briefly: what a chip shows before it is opened. */
function preview(args: string): string {
  try {
    const values = Object.values(JSON.parse(args) as Record<string, unknown>)
      .map((v) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v)))
      .join(' ')
    return values.length > 60 ? `${values.slice(0, 60)}…` : values
  } catch {
    return args.length > 60 ? `${args.slice(0, 60)}…` : args
  }
}

function time(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

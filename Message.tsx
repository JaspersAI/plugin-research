import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useData } from '@jaspers-ai/sdk'
import { numberCitations, numberKey, sourceTitle, type Citation, type NumberedCitation } from './citations'
import { CiteMark, Markdown, type CiteLookup } from './MarkdownView'
import {
  answerText,
  messageParts,
  processStatusText,
  threadStatusText,
  type AnalystMessage,
  type Message,
  type Step,
} from './room'

// One message in the thread, reading its own live value, so an analyst's progress re-renders its row
// and nothing else. The chat thread (MessageRow) shows only the user's questions and the analysts'
// final research answers, sources, and files; pre-answer narration, turn counts, and tool calls live
// in the separate Process view (ProcessRow).

interface Props {
  room: string
  seq: number
  colors: Record<string, string | null>
  onLink: (href: string) => void
  onFile: (path: string) => void
  /** Resolves true once the text is on the clipboard; a failure is the room's to show. */
  onCopy: (text: string) => Promise<boolean>
}

interface ProcessProps {
  room: string
  seq: number
  names: Record<string, string>
  colors: Record<string, string | null>
  onLink: (href: string) => void
}

export function MessageRow({ room, seq, colors, onLink, onFile, onCopy }: Props): ReactElement | null {
  const message = useData(`live/rooms/${room}/m/${seq}`) as Message | undefined
  const text = message?.role === 'analyst' ? message.text : ''
  const citations = message?.role === 'analyst' ? message.citations : undefined
  const parts = useMemo(
    () => (message?.role === 'analyst' ? messageParts(message) : { trail: [], answer: '' }),
    [message],
  )
  // Numbered from the full text, as the runner numbers them, while filtering Sources to what the final answer cites.
  const { cite, answerCitations } = useMemo<{ cite: CiteLookup; answerCitations: NumberedCitation[] }>(() => {
    const numbered = numberCitations(text)
    const citedInAnswer = new Set(numberCitations(parts.answer).map((c) => numberKey(c.attrs)))
    return {
      cite: {
        numbers: new Map(numbered.map((c) => [numberKey(c.attrs) ?? '', c.n])),
        resolved: new Map((citations ?? []).map((c) => [c.n, c])),
      },
      answerCitations: numbered.filter((c) => citedInAnswer.has(numberKey(c.attrs))),
    }
  }, [text, citations, parts.answer])
  const copy = useMemo(() => (message?.role === 'analyst' ? answerText(message) : ''), [message])
  if (!message) return null
  if (message.role === 'user') {
    return (
      <div className="rs-msg rs-you">
        <div className="rs-meta">
          <span className="rs-name">You</span>
        </div>
        <div className="rs-plain">{message.text}</div>
      </div>
    )
  }
  const files = Array.isArray(message.files) ? message.files : []
  return (
    <div className="rs-msg">
      <div className="rs-meta">
        <span className="rs-swatch" style={{ background: message.color ?? colors[message.analyst] ?? 'var(--jaspers-muted-foreground, #737373)' }} aria-hidden />
        <span className="rs-name">{message.name}</span>
        <span className={message.status === 'error' ? 'rs-error' : 'rs-muted'}>{threadStatusText(message)}</span>
      </div>
      {body(message, parts.answer, onLink, cite)}
      {copy && <CopyButton text={copy} onCopy={onCopy} />}
      {answerCitations.length > 0 && <Sources message={message} numbered={answerCitations} cite={cite} onLink={onLink} />}
      {files.length > 0 && (
        <div className="rs-files">
          {files.map((file) => (
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

export function ProcessRow({
  room,
  seq,
  names,
  colors,
  onLink,
}: ProcessProps): ReactElement | null {
  const message = useData(`live/rooms/${room}/m/${seq}`) as Message | undefined
  const text = message?.role === 'analyst' ? message.text : ''
  const citations = message?.role === 'analyst' ? message.citations : undefined
  const cite = useMemo<CiteLookup>(() => {
    const numbered = numberCitations(text)
    return {
      numbers: new Map(numbered.map((c) => [numberKey(c.attrs) ?? '', c.n])),
      resolved: new Map((citations ?? []).map((c) => [c.n, c])),
    }
  }, [text, citations])
  if (!message) return null
  if (message.role === 'user') {
    const targets = (message.to ?? []).map((id) => names[id] ?? id).join(', ')
    return (
      <div className="rs-msg rs-you">
        <div className="rs-meta">
          <span className="rs-name">You</span>
          {targets && <span className="rs-muted">→ {targets}</span>}
        </div>
        <div className="rs-plain">{message.text}</div>
        {message.context && (
          <details className="rs-trail">
            <summary className="rs-trail-head">
              <span>Context</span>
            </summary>
            <div className="rs-trail-body">
              <div className="rs-plain">{message.context}</div>
            </div>
          </details>
        )}
      </div>
    )
  }
  const steps = Array.isArray(message.steps) ? message.steps : []
  const { trail } = messageParts(message)
  return (
    <div className="rs-msg">
      <div className="rs-meta">
        <span className="rs-swatch" style={{ background: message.color ?? colors[message.analyst] ?? 'var(--jaspers-muted-foreground, #737373)' }} aria-hidden />
        <span className="rs-name">{message.name}</span>
        <span className={message.status === 'error' ? 'rs-error' : 'rs-muted'}>{processStatusText(message)}</span>
        {steps.length > 0 && <span className="rs-muted">· {steps.length} {steps.length === 1 ? 'call' : 'calls'}</span>}
      </div>
      {trail.length > 0 ? (
        <div className="rs-trail-body">
          {trail.map((block, i) => (
            <div key={`${block.at}-${i}`} className="rs-trail-round">
              {block.text && <Markdown source={block.text} onLink={onLink} cite={cite} />}
              {block.steps.length > 0 && <Steps steps={block.steps} />}
            </div>
          ))}
        </div>
      ) : (
        <p className="rs-muted">
          {message.status === 'queued'
            ? 'Waiting to start.'
            : message.status === 'working'
              ? 'Reading the question…'
              : 'No tool calls.'}
        </p>
      )}
      {message.error && message.status !== 'done' && (
        <p className={message.status === 'error' ? 'rs-error' : 'rs-muted'}>
          {message.status === 'error' ? `Error: ${message.error}` : `Stopped: ${message.error}`}
        </p>
      )}
    </div>
  )
}

function body(message: AnalystMessage, answer: string, onLink: (href: string) => void, cite: CiteLookup): ReactNode[] {
  const parts: ReactNode[] = []
  if (answer) parts.push(<Markdown key="answer" source={answer} onLink={onLink} cite={cite} />)
  if (message.status === 'queued') parts.push(<p key="queued" className="rs-muted">Waiting to start.</p>)
  if (message.status === 'working' && !answer) parts.push(<p key="start" className="rs-muted">Researching…</p>)
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
function Sources({
  message,
  numbered,
  cite,
  onLink,
}: {
  message: AnalystMessage
  numbered: NumberedCitation[]
  cite: CiteLookup
  onLink: (href: string) => void
}): ReactElement {
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

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

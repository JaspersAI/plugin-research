import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useBridge, useData, usePanelState, usePublish, type PanelRef } from '@jaspers-ai/sdk'
import type { Analyst } from './analysts'
import { MessageRow } from './Message'
import type { RoomLive } from './rooms'
import './styles.css'

// The research room. With no room in its state it lists the rooms there are and the analysts a room
// can have; with one, it is the thread: who is in the room and busy, every message as it grows, and
// the controls that need no words (stop, remove an analyst, show the folder). Talking to the room is
// the composer's job, through the orchestrator.

type Listed = Omit<Analyst, 'instructions'>

/** A room the orchestrator asked for by placing the view, not yet made. */
interface Start {
  name: string
  analysts: string[]
  tickers?: string[]
  ask?: string
}

interface RoomState {
  room?: string
  start?: Start
}

/** The panel's state arrives a round trip after the frame mounts; nothing is shown as a room until it has. */
export function RoomView({ panel }: { panel: PanelRef }): ReactElement {
  const state = useData(`workspaces/${panel.workspaceId}/panels/${panel.id}/state`) as RoomState | undefined
  if (state === undefined) {
    return (
      <div className="rs-root">
        <div className="rs-bar">
          <span className="rs-muted">Loading…</span>
        </div>
      </div>
    )
  }
  return <Room panel={panel} initial={state} />
}

/**
 * Which room this is. state.start is a room to make: the view creates it, posts its first question,
 * and writes the new id to state.room, so the orchestrator starts a room with one placement and never
 * has to know an id first. A state.room that names no room shows the rooms there are, and says so.
 */
function Room({ panel, initial }: { panel: PanelRef; initial: RoomState }): ReactElement {
  const bridge = useBridge()
  const [room, setRoom] = usePanelState<string | undefined>(panel, 'room', initial.room)
  const [start, setStart] = usePanelState<Start | undefined>(panel, 'start', initial.start)
  const analysts = (useData('live/analysts') as Listed[] | undefined) ?? []
  const [missing, setMissing] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const creating = useRef(false)

  // A different room, however it was set, gets its own chance to load.
  useEffect(() => {
    setMissing(null)
    setFailure(null)
  }, [room])

  useEffect(() => {
    if (!start || creating.current || (room && !missing)) return
    creating.current = true
    setFailure(null)
    void (async () => {
      try {
        const made = await bridge.runSource('research/create-room', { name: start.name, analysts: start.analysts, tickers: start.tickers ?? [] })
        const result = made.kind === 'text' ? (JSON.parse(made.text) as { room?: string; analysts?: string[]; unmatched?: string[] }) : {}
        const id = result.room
        if (!id) throw new Error('The room was not created.')
        setMissing(null)
        setRoom(id)
        setStart(undefined)
        const left = result.unmatched ?? []
        setNote(left.length > 0 ? `Left out ${left.join(', ')}: no analyst by that name.` : null)
        if (start.ask?.trim()) await bridge.runSource('research/post', { room: id, text: start.ask, to: result.analysts ?? start.analysts })
      } catch (err) {
        setFailure(`Could not start ${start.name}: ${err instanceof Error ? err.message : String(err)}`)
        setStart(undefined)
      } finally {
        creating.current = false
      }
    })()
  }, [bridge, start, room, missing, setRoom, setStart])

  if (room && !missing) {
    return <Thread key={room} panel={panel} room={room} analysts={analysts} note={note} onLeave={() => setRoom(undefined)} onMissing={setMissing} />
  }
  const notice = start ? null : failure ?? (missing && room ? `There is no room "${room}". Open one below, or ask Jaspers to start a room.` : null)
  return (
    <Picker
      panel={panel}
      analysts={analysts}
      starting={start?.name ?? null}
      notice={notice}
      onOpen={(id) => {
        setMissing(null)
        setFailure(null)
        setRoom(id)
      }}
    />
  )
}

function Picker({
  panel,
  analysts,
  starting,
  notice,
  onOpen,
}: {
  panel: PanelRef
  analysts: Listed[]
  starting: string | null
  notice: string | null
  onOpen: (room: string) => void
}): ReactElement {
  const { data, loading, error } = useData('research/rooms', {})
  const rooms = (data ?? []) as { id: string; name: string; tickers: string[]; analysts: string[]; working: string[] }[]
  usePublish(panel, {
    room: null,
    available: analysts.filter((a) => a.error === null).length,
    ...(starting ? { starting } : {}),
    ...(notice ? { error: notice } : {}),
  })
  return (
    <div className="rs-root">
      <div className="rs-bar">
        <span className="rs-title">Research rooms</span>
        <span className="rs-muted">Ask Jaspers: “start a research room on FLWS with Credit and Risk”.</span>
      </div>
      <div className="rs-scroll">
        {starting && <p className="rs-muted rs-pad">Starting {starting}…</p>}
        {notice && <p className="rs-error rs-pad">{notice}</p>}
        {error && <p className="rs-error rs-pad">{error}</p>}
        {loading && data === undefined && <p className="rs-muted rs-pad">Loading…</p>}
        {!loading && !error && rooms.length === 0 && !starting && <p className="rs-muted rs-pad">No rooms on this workspace yet.</p>}
        {rooms.map((room) => (
          <div key={room.id} className="rs-row">
            <div className="rs-body">
              <div className="rs-line">
                <span className="rs-name">{room.name}</span>
                <span className="rs-muted">{room.tickers.join(', ')}</span>
              </div>
              <div className="rs-muted">
                {room.analysts.join(', ') || 'no analysts'}
                {room.working.length > 0 ? ` · ${room.working.join(', ')} working` : ''}
              </div>
            </div>
            <button type="button" className="rs-btn" onClick={() => onOpen(room.id)}>
              Open
            </button>
          </div>
        ))}
        <div className="rs-section">Analysts</div>
        {analysts.map((analyst) => (
          <div key={analyst.id} className="rs-row">
            <span className="rs-swatch" style={{ background: analyst.color ?? 'var(--jaspers-muted-foreground, #737373)' }} aria-hidden />
            <div className="rs-body">
              <div className="rs-line">
                <span className="rs-name">{analyst.name}</span>
                <span className="rs-muted">
                  {analyst.id}
                  {analyst.origin === 'user' ? ' · yours' : ''}
                </span>
              </div>
              {analyst.error !== null ? <div className="rs-error">{analyst.error}</div> : <div className="rs-muted rs-clamp">{analyst.description}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Thread({
  panel,
  room,
  analysts,
  note,
  onLeave,
  onMissing,
}: {
  panel: PanelRef
  room: string
  analysts: Listed[]
  note: string | null
  onLeave: () => void
  onMissing: (message: string) => void
}): ReactElement {
  const bridge = useBridge()
  const live = useData(`live/rooms/${room}`) as RoomLive | undefined
  // The room is loaded into the host when the view opens, and again if the host restarted and its
  // live values went away with it.
  const [attempt, setAttempt] = useState(0)
  const { error } = useData('research/load-room', { room, attempt })
  // A room id that names no room goes back to the list, which says so.
  useEffect(() => {
    if (error && /^No room /.test(error)) onMissing(error)
  }, [error, onMissing])
  const had = useRef(false)
  useEffect(() => {
    if (live) had.current = true
    else if (had.current) {
      had.current = false
      setAttempt((n) => n + 1)
    }
  }, [live])
  usePublish(panel, live ? { ...live.output } : { room })

  const names = useMemo(() => Object.fromEntries(analysts.map((a) => [a.id, a.name])), [analysts])
  const colors = useMemo(() => Object.fromEntries(analysts.map((a) => [a.id, a.color])), [analysts])
  const [problem, setProblem] = useState<string | null>(null)
  const act = (source: string, args: Record<string, unknown>): void => {
    setProblem(null)
    bridge.runSource(source, args).catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)))
  }
  const copy = (text: string): Promise<boolean> => {
    setProblem(null)
    return bridge.copyText(text).then(
      () => true,
      (err: unknown) => {
        setProblem(err instanceof Error ? err.message : String(err))
        return false
      },
    )
  }

  // Follow new content while the reader is at the bottom; leave them be once they scroll up.
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const box = scroller.current
    const inner = content.current
    if (!box || !inner) return
    const observer = new ResizeObserver(() => {
      if (pinned.current) box.scrollTop = box.scrollHeight
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  const output = live?.output
  const busy = output?.analysts.some((a) => a.status !== 'idle') ?? false
  return (
    <div className="rs-root">
      <div className="rs-bar">
        <button type="button" className="rs-link" onClick={onLeave}>
          Rooms
        </button>
        <span className="rs-title">{live?.room.name ?? room}</span>
        {live?.room.tickers.map((ticker) => (
          <span key={ticker} className="rs-tag">
            {ticker}
          </span>
        ))}
        <span className="rs-roster">
          {output?.analysts.map((analyst) => (
            <span key={analyst.id} className="rs-chip">
              <span className="rs-swatch" style={{ background: colors[analyst.id] ?? 'var(--jaspers-muted-foreground, #737373)' }} aria-hidden />
              {analyst.name}
              {analyst.status !== 'idle' && <span className="rs-muted"> {analyst.status}</span>}
              <button
                type="button"
                className="rs-x"
                aria-label={`Remove ${analyst.name}`}
                onClick={() => act('research/update-room', { room, analysts: live!.room.analysts.filter((id) => id !== analyst.id) })}
              >
                ×
              </button>
            </span>
          ))}
        </span>
        {busy && (
          <button type="button" className="rs-btn" onClick={() => act('research/stop', { room })}>
            Stop
          </button>
        )}
        <button type="button" className="rs-btn" onClick={() => act('research/reveal', { room })}>
          Show folder
        </button>
      </div>
      {note && <p className="rs-muted rs-pad">{note}</p>}
      {(error || problem) && <p className="rs-error rs-pad">{problem ?? error}</p>}
      <div
        className="rs-scroll"
        ref={scroller}
        onScroll={(event) => {
          const box = event.currentTarget
          pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
        }}
      >
        <div ref={content} className="rs-thread">
          {live && live.seqs.length === 0 && (
            <p className="rs-muted rs-pad">No messages yet. Talk to the room through Jaspers: “ask Credit what the refinancing risk is”.</p>
          )}
          {live?.seqs.map((seq) => (
            <MessageRow
              key={seq}
              room={room}
              seq={seq}
              names={names}
              colors={colors}
              onLink={(href) => void bridge.openLink(href).catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)))}
              onFile={(path) => act('research/open-file', { room, path })}
              onCopy={copy}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

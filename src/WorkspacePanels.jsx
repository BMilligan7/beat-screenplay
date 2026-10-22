import { useEffect, useId, useRef, useState } from "react";
import "./workspace.css";

function WorkspaceDialog({ title, description, children, onClose, busy, wide = false }) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    (dialog.querySelector("[data-autofocus]") || dialog).focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  function handleKeys(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const targets = [...dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')]
      .filter((element) => element.getClientRects().length);
    if (!targets.length) { event.preventDefault(); return; }
    const first = targets[0];
    const last = targets.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  return <div className="workspace-dialog-backdrop">
    <section ref={dialogRef} className={`workspace-dialog${wide ? " workspace-dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={!!busy} tabIndex={-1} onKeyDown={handleKeys}>
      <header className="workspace-dialog-header">
        <div><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div>
        <button type="button" className="workspace-close" aria-label={`Close ${title.toLowerCase()}`} disabled={busy} onClick={onClose}>×</button>
      </header>
      {children}
    </section>
  </div>;
}

function ErrorMessage({ error }) {
  return error ? <p className="workspace-error" role="alert">{typeof error === "string" ? error : error.message || "Something went wrong. Please try again."}</p> : null;
}

function WriterName({ writerName, setWriterName, disabled, autoFocus = false }) {
  const inputId = useId();
  const helpId = useId();
  return <div className="workspace-writer-field">
    <label htmlFor={inputId}>Your name</label>
    <input id={inputId} data-autofocus={autoFocus ? "true" : undefined} autoComplete="name" value={writerName || ""} maxLength={80} required disabled={disabled} onChange={(event) => setWriterName(event.target.value)} aria-describedby={helpId} placeholder="Name shown in the shared history" />
    <p id={helpId}>Names are entered by each writer and are not verified accounts.</p>
  </div>;
}

function formatTime(value) {
  if (!value) return "Time not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time not recorded";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function authorLabel(event) {
  if (event?.authorIdentity === "unknown" || !event?.authorName?.trim()) return "Writer not recorded";
  return event.authorName;
}

function eventLabel(kind) {
  const labels = {
    baseline: "Starting version",
    sessioncreated: "Session started",
    session_created: "Session started",
    "session-created": "Session started",
    sessionsaved: "Session saved",
    session_saved: "Session saved",
    "session-saved": "Session saved",
    saved: "Session saved",
    madecurrent: "Made current",
    made_current: "Made current",
    "made-current": "Made current",
    promoted: "Made current",
  };
  return labels[kind] || "Saved change";
}

function eventRevision(event) {
  const madeCurrent = ["madecurrent", "made_current", "made-current", "promoted"].includes(event.kind);
  return madeCurrent || event.sessionRevision === undefined || event.sessionRevision === null
    ? `Current ${event.mainRevision ?? "—"}` : `Session ${event.sessionRevision}`;
}

function ChangeSummary({ summary = {} }) {
  const parts = [["added", "added"], ["removed", "removed"], ["changed", "changed"], ["moved", "moved"]]
    .filter(([key]) => Number(summary[key]) > 0)
    .map(([key, label]) => `${summary[key]} ${label}`);
  if (summary.renamed) parts.push("Draft renamed");
  return <span className="workspace-change-summary">{parts.length ? parts.join(" · ") : "No screenplay changes recorded"}</span>;
}

function ElementVersion({ block, label }) {
  return <div className={`workspace-element-version workspace-element-${label.toLowerCase()}`}>
    <div className="workspace-element-heading"><strong>{label}</strong>{block && <span>{block.type || "Unspecified format"}</span>}{Number.isInteger(block?.index) && block.index >= 0 && <small className="workspace-element-position">Position {block.index + 1}</small>}</div>
    {block ? <pre>{block.text || <span className="workspace-empty-text">Empty element</span>}</pre> : <p className="workspace-absent">{label === "Before" ? "New element" : "Element removed"}</p>}
  </div>;
}

function ChangeList({ changes = [], beforeName, afterName }) {
  const renamed = beforeName && afterName && beforeName !== afterName;
  if (!changes.length && !renamed) return <p className="workspace-empty">The screenplay text and formats match this version.</p>;
  return <div className="workspace-changes">
    {renamed && <div className="workspace-rename"><strong>Draft name</strong><span>{beforeName}</span><span aria-hidden="true">→</span><span>{afterName}</span></div>}
    {changes.map((change, index) => <article className="workspace-change" key={`${change.id || "change"}-${index}`}>
      <h4>Change {index + 1}<span>{change.kind === "added" ? "Added" : change.kind === "removed" ? "Removed" : change.kind === "moved" ? "Moved" : "Changed"}</span></h4>
      <div className="workspace-change-columns"><ElementVersion block={change.before} label="Before" /><ElementVersion block={change.after} label="After" /></div>
    </article>)}
  </div>;
}

export function SessionStartDialog({ writerName, setWriterName, onStart, onClose, busy = false, error, sourceName }) {
  const source = sourceName?.trim() || "the current screenplay";
  return <WorkspaceDialog title="Start an editing session" description={`Work on a saved copy of ${source}. Review your changes when you are ready to make them current.`} onClose={onClose} busy={busy}>
    <form className="workspace-dialog-form" onSubmit={(event) => { event.preventDefault(); if (!busy && writerName?.trim()) onStart(); }}>
      <div className="workspace-dialog-body"><WriterName writerName={writerName} setWriterName={setWriterName} disabled={busy} autoFocus /><ErrorMessage error={error} /></div>
      <footer className="workspace-dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !writerName?.trim()}>{busy ? "Starting session…" : "Start session"}</button></footer>
    </form>
  </WorkspaceDialog>;
}

export function SessionReviewDialog({ review, writerName, setWriterName, onPromote, onClose, busy = false, error }) {
  const [confirmedRevision, setConfirmedRevision] = useState(null);
  const revisionKey = JSON.stringify([review?.session?.id, review?.main?.revision, review?.session?.revision, review?.draft?.revision]);
  const confirmed = confirmedRevision === revisionKey;
  useEffect(() => { setConfirmedRevision(null); }, [revisionKey]);
  const acknowledgementId = useId();
  const ready = !!review?.main && !!review?.session && !!review?.draft;
  function promote(event) {
    event.preventDefault();
    if (!ready || busy || !confirmed || !writerName?.trim()) return;
    onPromote({ reviewed: true, mainRevision: review.main.revision, sessionRevision: review.draft.revision ?? review.session.revision });
  }
  return <WorkspaceDialog title="Review before making current" description="Compare this session with the current screenplay, then confirm the changes you want everyone to use." onClose={onClose} busy={busy} wide>
    <form className="workspace-dialog-form" onSubmit={promote}>
      <div className="workspace-dialog-body">
        {!ready ? <p className="workspace-loading" role="status">Loading the latest versions…</p> : <>
          <div className="workspace-review-versions">
            <div><span>Current screenplay</span><strong>{review.main.draftName}</strong><small>Revision {review.main.revision} · {formatTime(review.main.updatedAt)}</small></div>
            <div><span>Session under review</span><strong>{review.draft.draftName || review.session.draftName}</strong><small>{review.session.authorName || "Writer not recorded"} · Revision {review.draft.revision ?? review.session.revision}</small></div>
          </div>
          <p className="workspace-session-base"><strong>Current at session start:</strong> {review.session.baseDraftName || "Draft name not recorded"} · {review.session.baseMainRevision === undefined ? "Revision not recorded" : `Revision ${review.session.baseMainRevision}`}</p>
          {review.session.baseMainRevision !== undefined && review.session.baseMainRevision !== review.main.revision && <p className="workspace-review-note">The current screenplay has changed since this session started. Review the latest differences below before continuing.</p>}
          <div className="workspace-diff-heading"><h3>Changes to the current screenplay</h3><ChangeSummary summary={review.summary} /></div>
          <ChangeList changes={review.changes} beforeName={review.main.draftName} afterName={review.draft.draftName} />
          <WriterName writerName={writerName} setWriterName={setWriterName} disabled={busy} />
          <label className="workspace-acknowledgement" htmlFor={acknowledgementId}><input id={acknowledgementId} type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmedRevision(event.target.checked ? revisionKey : null)} /><span>I reviewed these changes and want this session to become the current screenplay.</span></label>
        </>}
        <ErrorMessage error={error} />
      </div>
      <footer className="workspace-dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Back to script</button><button type="submit" className="primary-button" disabled={!ready || busy || !confirmed || !writerName?.trim()}>{busy ? "Making current…" : "Make current"}</button></footer>
    </form>
  </WorkspaceDialog>;
}

export function SharedHistoryDialog({ events = [], nextCursor, detail, onSelect, onLoadMore, onFork, onClose, busy = false, error }) {
  const selectedEvent = detail?.event;
  const snapshot = detail?.snapshot;
  return <WorkspaceDialog title="Shared history" description="See saved sessions and changes to the current screenplay. Names are entered by writers; older changes may have no recorded author." onClose={onClose} busy={busy} wide>
    <div className="workspace-dialog-body">
      <ErrorMessage error={error} />
      {!events.length && <p className="workspace-empty" role={busy ? "status" : undefined}>{busy ? "Loading shared history…" : "No shared history has been recorded yet."}</p>}
      <ol className="workspace-history-list">
        {events.map((event) => <li key={event.id}><button type="button" className={`workspace-history-event${selectedEvent?.id === event.id ? " is-selected" : ""}`} disabled={busy} aria-pressed={selectedEvent?.id === event.id} onClick={() => onSelect(event.id)}>
          <span className="workspace-history-marker" aria-hidden="true" />
          <span className="workspace-history-description"><strong>{eventLabel(event.kind)}<span>{event.draftName || "Unnamed draft"}</span></strong><small>{authorLabel(event)} · {formatTime(event.createdAt)}</small><ChangeSummary summary={event.summary} /></span>
          <span className="workspace-history-revision">{eventRevision(event)}</span>
        </button></li>)}
      </ol>
      {nextCursor && <button type="button" className="secondary-button workspace-load-more" disabled={busy} onClick={onLoadMore}>{busy ? "Loading…" : "Load earlier history"}</button>}
      {selectedEvent && <section className="workspace-history-detail" aria-label="Selected version">
        <div className="workspace-diff-heading"><h3>{eventLabel(selectedEvent.kind)} · {snapshot?.draftName || selectedEvent.draftName}</h3><p>{authorLabel(selectedEvent)} · {formatTime(selectedEvent.createdAt)} · {eventRevision(selectedEvent)}</p><ChangeSummary summary={selectedEvent.summary} /></div>
        <ChangeList changes={detail.changes} />
        {snapshot && <details className="workspace-snapshot"><summary>View full saved screenplay ({snapshot.blocks?.length || 0} elements)</summary><div>{(snapshot.blocks || []).map((block, index) => <article key={`${block.id || "element"}-${index}`}><span>{index + 1} · {block.type}</span><pre>{block.text || <span className="workspace-empty-text">Empty element</span>}</pre></article>)}</div></details>}
      </section>}
      {busy && events.length > 0 && <p className="workspace-loading" role="status">Loading…</p>}
    </div>
    <footer className="workspace-dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Close history</button><button type="button" className="primary-button" disabled={busy || !selectedEvent || !snapshot?.blocks?.length} onClick={() => onFork(selectedEvent.id)}>Start session from this version</button></footer>
  </WorkspaceDialog>;
}

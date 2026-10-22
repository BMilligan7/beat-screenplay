import { useState } from "react";
import { FileText, Plus, ArrowRight } from "@phosphor-icons/react";
import "./projects.css";

export function ProjectLibrary({ projects = [], loading, error, onRefresh, onOpen, onCreate, onImportLink, linkError, creating, onResumeLocal, localTitle }) {
  const [name, setName] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [link, setLink] = useState("");
  return <main className="project-library">
    <header className="library-topbar"><span className="wordmark">Beat</span><span>Shared screenplay library</span></header>
    <div className="library-content">
      <header className="library-heading"><div><p className="library-eyebrow">THE WRITING ROOM</p><h1>Projects</h1><p>A place for every script. Shared with everyone using this Beat site.</p></div><button className="primary-button" disabled={creating} onClick={() => setNewOpen(true)}><Plus size={18}/> New project</button></header>
      {newOpen && <form className="new-project-form" onSubmit={async (event) => { event.preventDefault(); if (await onCreate(name)) { setName(""); setNewOpen(false); } }}>
        <div><label htmlFor="new-project-name">Project title</label><input id="new-project-name" value={name} maxLength={120} autoFocus required disabled={creating} onChange={event => setName(event.target.value)} placeholder="Name your screenplay"/></div>
        <button className="primary-button" disabled={creating || !name.trim()}>{creating ? "Creating…" : "Create project"}</button><button type="button" className="secondary-button" disabled={creating} onClick={() => setNewOpen(false)}>Cancel</button>
      </form>}
      {error && <div className="library-error" role="alert">{error}<button onClick={onRefresh}>Try again</button></div>}
      {loading && !projects.length ? <p role="status">Loading projects…</p> : <div className="project-grid">{projects.map(project => <button className="project-card" key={project.roomId} disabled={creating} onClick={() => onOpen(project)}>
        <span className="project-cover"><FileText size={30} weight="light"/><span>SCREENPLAY</span></span>
        <span className="project-card-content"><strong>{project.name}</strong><small>{project.draftName || "Draft 1"}{project.updatedAt ? ` · ${new Intl.DateTimeFormat(undefined, {month:"short",day:"numeric"}).format(new Date(project.updatedAt))}` : ""}</small><span>Open project <ArrowRight size={17}/></span></span>
      </button>)}</div>}
      {!loading && !error && !projects.length && <div className="library-empty"><FileText size={40} weight="light"/><h2>Your next story starts here</h2><p>Create a project, or open an existing script using its full collaboration link.</p></div>}
      <details className="library-existing" open={linkError ? true : undefined}><summary>Open an existing script by link</summary><form onSubmit={event => { event.preventDefault(); onImportLink(link); }}><label htmlFor="library-script-link">Full collaboration link</label><div><input id="library-script-link" value={link} onChange={event => setLink(event.target.value)} placeholder="Paste the full Beat link" required/><button className="secondary-button" disabled={creating}>Open script</button></div>{linkError && <p role="alert">{linkError}</p>}</form></details>
      {onResumeLocal && <button className="library-local" disabled={creating} onClick={onResumeLocal}>Continue recovery copy on this device{localTitle ? ` · ${localTitle}` : ""}</button>}
    </div>
  </main>;
}

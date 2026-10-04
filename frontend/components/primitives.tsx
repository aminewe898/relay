'use client';
import Link from 'next/link';
import { label, type Activity, type ServiceHealth } from '../lib/model';
import { Icon } from './shell/icon';
export function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Madrid'}).format(new Date(value));
}
export function State({ value }: { value: string }) {
  const tone = ['critical','needs_attention','needs_operator','uncertain','unavailable'].includes(value) ? 'danger' : ['queued','high','waiting_input'].includes(value) || value.startsWith('awaiting') ? 'warning' : ['succeeded','sent','resolved','closed'].includes(value) ? 'success' : 'neutral';
  return <span className={`state state-${tone}`}><span/>{label(value)}</span>;
}
export function Section({ title, meta, children, className='' }: { title: string; meta?: React.ReactNode; children: React.ReactNode; className?:string }) {
  return <section className={`section ${className}`}><div className="section-heading"><h2>{title}</h2>{meta}</div>{children}</section>;
}
export function Empty({ title, detail }: { title:string;detail:string }) { return <div className="empty-state"><Icon name="info" size={17}/><div><strong>{title}</strong><p>{detail}</p></div></div>; }
export function LoadingRows({ count=5 }: { count?:number }) { return <div role="status" aria-label="Loading backend data" className="loading-rows">{Array.from({length:count},(_,i)=><div key={i}><span/><span/><span/></div>)}</div>; }
export function ErrorState({ retry, message='Backend unavailable' }: { retry:()=>void;message?:string }) { return <div role="alert" className="error-state"><Icon name="info" size={16}/><strong>{message}</strong><button onClick={retry} className="button small">Retry</button></div>; }
export function ActivityRows({ events, limit=15 }: { events:Activity[];limit?:number }) { return events.length ? <div className="activity-stream">{events.slice(0,limit).map(e=><Link href={e.href} key={e.id} className="activity-row"><span className="event-symbol"><Icon name={e.kind==='ticket'?'ticket':e.kind==='client'?'people':e.kind==='attention'?'info':'bolt'} size={13}/></span><span>{e.title}<small>{e.provenance}</small></span><time>{formatDate(e.occurredAt)}</time></Link>)}</div> : <Empty title="No activity recorded" detail="Activity comes from persistent message, intake, ticket and delivery timestamps."/>; }
export function HealthTable({ services }: { services:ServiceHealth[] }) { return <div className="table-scroll"><table className="data-table service-table"><thead><tr><th>Service</th><th>State</th><th>Last recorded success</th><th>Queued</th><th>Running</th><th>Needs review</th><th>Uncertain</th><th>Oldest outstanding</th><th>Avg. latency</th></tr></thead><tbody>{services.map(s=><tr key={s.key}><td title={s.evidence}><strong>{s.name}</strong></td><td><State value={s.status}/></td><td className="mono nowrap">{formatDate(s.lastSuccessAt)}</td><td className="numeric">{s.queued??'—'}</td><td className="numeric">{s.running??'—'}</td><td className="numeric">{s.failed??'—'}</td><td className="numeric">{s.uncertain??'—'}</td><td className="mono nowrap">{formatDate(s.oldestAt)}</td><td>{s.averageLatencyMs===null?'—':`${s.averageLatencyMs}ms`}</td></tr>)}</tbody></table></div>; }

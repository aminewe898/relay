'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { Activity, Intake, Snapshot, Ticket } from '../../lib/model';
import { useApi } from '../../lib/queries';
import { ActivityRows, Empty, ErrorState, formatDate, LoadingRows, Section, State } from '../primitives';
type TicketDetail={ticket:Ticket;intake:Intake|null;events:Activity[]};
const fieldNames:Record<string,string>={clientName:'Customer name',company:'Company',email:'Email at extraction',prioritySuggestion:'Priority',technicalDetails:'Technical details',onsetText:'When it started',businessImpact:'Business impact',urgencyEvidence:'Urgency evidence'};
export function TicketWorkspace({id,snapshot}:{id:string;snapshot:Snapshot}) {
  const [tab,setTab]=useState('record');
  const {data,error,isLoading,mutate}=useApi<TicketDetail>(`/api/v1/tickets/${id}`);
  if(error)return <ErrorState retry={()=>mutate()} message={error.status===404?'Ticket not found':error.message}/>;
  if(isLoading||!data)return <LoadingRows count={8}/>;
  const {ticket:t,intake,events}=data;
  const related=snapshot.tickets.filter(x=>x.customerId===t.customerId&&x.id!==t.id);
  return <div className="ticket-desk"><div className="record-header"><div className="record-breadcrumb"><Link href="/tickets">Tickets</Link><span>/</span><span>{t.humanIdentifier}</span></div><h1>{t.summary}</h1><span className="record-origin">Voice intake · {formatDate(t.createdAt)}</span></div>
    <div className="ticket-panes">
      <aside className="context-pane"><Section title="Ticket properties"><dl className="property-list"><dt>Status</dt><dd><State value={t.status}/></dd><dt>Priority</dt><dd><State value={t.priority}/></dd><dt>Category</dt><dd>{t.category}</dd><dt>Technician</dt><dd className="unavailable">Not recorded</dd><dt>Asset</dt><dd className="unavailable">Not linked</dd><dt>SLA</dt><dd className="unavailable">Not recorded</dd></dl></Section><Section title="Dates"><dl className="property-list"><dt>Created</dt><dd>{formatDate(t.createdAt)}</dd><dt>Updated</dt><dd>{formatDate(t.updatedAt)}</dd></dl></Section><div className="pane-note">This workspace has read access. Status and assignment changes are not supported.</div></aside>
      <div className="work-pane"><div className="record-tabs" role="tablist" aria-label="Ticket content">{[['record','Record'],['activity','Activity'],['transcript','Original transcript']].map(([key,name])=><button key={key} role="tab" aria-selected={tab===key} aria-controls="ticket-content" className={tab===key?'active':''} onClick={()=>setTab(key)}>{name}{key==='activity'&&<span>{events.length}</span>}</button>)}</div>
        <div role="tabpanel" id="ticket-content" aria-label={tab==='record'?'Record':tab==='activity'?'Activity':'Original transcript'}>
          {tab==='record'&&<div className="ticket-message"><div className="message-heading"><span className="requester-avatar">{(t.clientName??'?').slice(0,1).toUpperCase()}</span><div><Link href={`/customers/${t.customerId}`}>{t.clientName}</Link><span>Reported through voice intake</span></div><time>{formatDate(t.createdAt)}</time></div><h2>Reported issue</h2><p className="preserve">{t.description}</p>{!!t.technicalDetails?.length&&<><h3>Technical details</h3><ul>{t.technicalDetails.map((x,i)=><li key={i}>{x}</li>)}</ul></>}<div className="message-footer"><button className="text-link" onClick={()=>setTab('transcript')}>Read original transcript</button><button className="text-link" onClick={()=>setTab('activity')}>View intake history ({events.length})</button></div></div>}
          {tab==='activity'&&<><ActivityRows events={events} limit={200}/><div className="pane-note">Events come from recorded intake and delivery timestamps. Technician notes and status transitions are not stored.</div></>}
          {tab==='transcript'&&<div className="ticket-message"><h2>Original voice transcript</h2>{intake?.transcript?<p className="preserve">{intake.transcript}</p>:<Empty title="No transcript available" detail="This intake did not return a stored transcript."/>}<div className="pane-note">Original source text. Technical claims require verification.</div></div>}
        </div><div className="record-readonly-note">Notes and replies are unavailable in this read-only workspace. Operator input continues through Telegram.</div>
      </div>
      <aside className="intelligence-pane"><Section title="Customer"><Link className="record-name" href={`/customers/${t.customerId}`}>{t.clientName}</Link><dl className="property-list"><dt>Contact</dt><dd>{t.contactName??'Not named'}</dd><dt>Email</dt><dd>{t.contactEmail?<a href={`mailto:${t.contactEmail}`}>{t.contactEmail}</a>:'—'}</dd></dl><Link className="text-link section-link" href={`/customers/${t.customerId}`}>Customer history →</Link></Section>
        <Section title="Intake extraction"><div className="evidence-block"><p className="extraction-note">Model suggestions · confidence not recorded</p><dl className="property-list"><dt>Category</dt><dd>{intake?.categorySuggestion??'Unknown'}</dd><dt>Priority</dt><dd>{intake?.prioritySuggestion??'Unknown'}</dd>{t.affectedSystem&&<><dt>System</dt><dd>{t.affectedSystem}</dd></>}</dl>{!!t.symptoms?.length&&<><h3>Reported symptoms</h3><ul>{t.symptoms.map((x,i)=><li key={i}>{x}</li>)}</ul></>}{t.businessImpact&&<><h3>Business impact</h3><p>{t.businessImpact}</p></>}{t.urgencyEvidence&&<><h3>Urgency evidence</h3><p>{t.urgencyEvidence}</p></>}{t.onsetText&&<><h3>When it started</h3><p>{t.onsetText}</p></>}</div><details className="missing-fields"><summary>Unknown at extraction ({intake?.missingInformation?.length??0})</summary><ul>{intake?.missingInformation?.map((m,i)=><li key={i}>{fieldNames[m]??m}</li>)}</ul><p>Fields may have been supplied later; these describe the original extraction.</p></details></Section>
        <Section title="Other customer tickets">{related.length?related.map(x=><Link className="related-row" href={`/tickets/${x.id}`} key={x.id}><span>{x.humanIdentifier}</span><strong>{x.summary}</strong><State value={x.status}/></Link>):<div className="pane-note">No other tickets in the current snapshot.</div>}</Section>
      </aside>
    </div></div>;
}

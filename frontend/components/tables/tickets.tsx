'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Snapshot, Ticket } from '../../lib/model';
import { useApi } from '../../lib/queries';
import { Empty, ErrorState, formatDate, LoadingRows, State } from '../primitives';
import { Icon } from '../shell/icon';

type TicketPage={data:Ticket[];total:number;page:number;limit:number};
const columnNames={subject:'Subject',id:'ID',customer:'Customer',status:'Status',priority:'Priority',updated:'Updated',created:'Created',asset:'Asset',technician:'Technician',sla:'SLA'};
type Column=keyof typeof columnNames;
const defaultColumns:Column[]=['subject','id','customer','status','priority','updated'];
export function TicketTable({tickets,comfortable=false,columns=defaultColumns,onSort}:{tickets:Ticket[];comfortable?:boolean;columns?:Column[];onSort?:(sort:string)=>void}) {
  const router=useRouter();
  const sorting:Partial<Record<Column,string>>={subject:'summary',id:'id',priority:'priority',created:'created',updated:'updated'};
  function cell(t:Ticket,column:Column) {
    if(column==='subject')return <Link className="ticket-subject" title={t.summary} href={`/tickets/${t.id}`}>{t.summary}</Link>;
    if(column==='id')return <Link className="ticket-key" href={`/tickets/${t.id}`}>{t.humanIdentifier??`TI-${t.number}`}</Link>;
    if(column==='customer')return <Link className="customer-cell" title={t.clientName??'Unavailable'} href={`/customers/${t.customerId}`}>{t.clientName??'Unavailable'}</Link>;
    if(column==='status'||column==='priority')return <State value={t[column]}/>;
    if(column==='created'||column==='updated')return <time>{formatDate(t[column==='created'?'createdAt':'updatedAt'])}</time>;
    return <span className="unavailable" title={`${columnNames[column]} is not recorded by this backend`}>—</span>;
  }
  return <><div className="mobile-ticket-list">{tickets.map(t=><Link key={t.id} href={`/tickets/${t.id}`} className="mobile-ticket-row"><span className="mobile-ticket-meta"><strong>{t.humanIdentifier??`TI-${t.number}`}</strong><State value={t.priority}/><State value={t.status}/></span><strong>{t.summary}</strong><span>{t.clientName??'Customer unavailable'}</span><small>Updated {formatDate(t.updatedAt)}</small></Link>)}</div>
    <div className="table-scroll ticket-desktop"><table className={`data-table ticket-table ${comfortable?'comfortable':''}`}><thead><tr>{columns.map(c=><th key={c} className={`column-${c}`}>{onSort&&sorting[c]?<button className="column-sort" onClick={()=>onSort(sorting[c]!)}>{columnNames[c]} <Icon name="chevron" size={12}/></button>:columnNames[c]}</th>)}<th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody onKeyDown={e=>{if(!(e.target instanceof HTMLTableRowElement))return;const rows=Array.from(e.currentTarget.rows);const idx=rows.indexOf(e.target);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();rows[Math.max(0,Math.min(rows.length-1,idx+(e.key==='ArrowDown'?1:-1)))]?.focus();}if(e.key==='Enter')router.push(`/tickets/${e.target.dataset.id}`);}}>{tickets.map(t=><tr key={t.id} tabIndex={0} data-id={t.id}>{columns.map(c=><td key={c} className={`column-${c}`}>{cell(t,c)}</td>)}<td><details className="row-menu"><summary aria-label={`Actions for ${t.humanIdentifier??t.number}`}>···</summary><div><Link href={`/tickets/${t.id}`}>Open ticket</Link><Link href={`/customers/${t.customerId}`}>Open customer</Link><button disabled title="Assignment API not available">Assign — unavailable</button><button disabled title="Audited status command not available">Change status — unavailable</button></div></details></td></tr>)}</tbody>
    </table></div></>;
}
export function Tickets({snapshot}:{snapshot?:Snapshot}) {
  const params=useSearchParams();const router=useRouter();
  const key=params.toString();const {data,error,isLoading,mutate}=useApi<TicketPage>(`/api/v1/tickets?${key}`);
  const density=params.get('density')??'compact';
  const [views,setViews]=useState<{name:string;query:string}[]>([]);
  const [columns,setColumns]=useState<Column[]>(defaultColumns);
  const [saving,setSaving]=useState(false);const [viewName,setViewName]=useState('');
  useEffect(()=>{try{const saved=JSON.parse(localStorage.getItem('relay.ticketViews')??'[]');if(Array.isArray(saved))setViews(saved.filter(v=>v&&typeof v.name==='string'&&typeof v.query==='string'));const stored=JSON.parse(localStorage.getItem('relay.ticketColumns')??'null');if(Array.isArray(stored)){const valid=stored.filter((c:Column)=>typeof c==='string'&&Object.keys(columnNames).includes(c));if(valid.includes('subject')&&valid.includes('id'))setColumns(valid);}}catch{}},[]);
  function toggleColumn(column:Column){const next=columns.includes(column)?columns.filter(c=>c!==column):[...columns,column];setColumns(next);localStorage.setItem('relay.ticketColumns',JSON.stringify(next));}
  function saveView(){if(!viewName.trim())return;const next=[...views,{name:viewName.trim(),query:key}];setViews(next);localStorage.setItem('relay.ticketViews',JSON.stringify(next));setSaving(false);setViewName('');}
  function removeView(index:number){const next=views.filter((_,i)=>i!==index);setViews(next);localStorage.setItem('relay.ticketViews',JSON.stringify(next));}
  function change(value:string,name:string){const next=new URLSearchParams(key);next.set(name,value);if(name!=='page')next.delete('page');router.push(`/tickets?${next}`);}
  const page=data?.page??1;const status=params.get('status');
  const queues=[{name:'All tickets',href:'/tickets',status:null,count:snapshot?.stats?.totalTickets},{name:'Open tickets',href:'/tickets?status=open',status:'open',count:undefined},{name:'In progress',href:'/tickets?status=in_progress',status:'in_progress',count:undefined},{name:'Resolved',href:'/tickets?status=resolved',status:'resolved',count:undefined}];
  const selected=queues.find(q=>q.status===(status==='all'?null:status))?.name??'Filtered tickets';
  return <div className="queue-layout ticket-list-layout"><aside className="queue-navigation" aria-label="Ticket views"><h2>Ticket views</h2>{queues.map(q=><Link key={q.name} href={q.href} className={q.status===(status==='all'?null:status)?'selected':''}><span>{q.name}</span>{q.count!==undefined&&<span className="queue-count">{q.count}</span>}</Link>)}<div className="queue-group"><h3>Saved views</h3>{views.map((v,i)=><div className="saved-view" key={`${v.name}-${i}`}><Link href={`/tickets?${v.query}`}>{v.name}</Link><button aria-label={`Remove saved view ${v.name}`} onClick={()=>removeView(i)}>×</button></div>)}{!views.length&&<p>Save a filtered list for quick access.</p>}<button className="save-view-trigger" onClick={()=>setSaving(!saving)}>+ Save current view</button>{saving&&<form className="save-view-form" onSubmit={e=>{e.preventDefault();saveView();}}><input aria-label="View name" placeholder="View name" maxLength={60} value={viewName} onChange={e=>setViewName(e.target.value)}/><button className="button" type="submit" disabled={!viewName.trim()}>Save</button></form>}</div></aside>
    <div className="queue-workspace"><div className="queue-heading"><div><h2>{selected}</h2><span>{data?.total??'—'} tickets</span></div><details className="column-picker"><summary className="button">Columns</summary><div><h3>Visible columns</h3>{(Object.keys(columnNames) as Column[]).map(c=><label key={c}><input type="checkbox" checked={columns.includes(c)} disabled={c==='subject'||c==='id'} onChange={()=>toggleColumn(c)}/>{columnNames[c]}</label>)}</div></details></div>
      <form className="filter-toolbar" action="/tickets" method="get"><div className="search-input"><Icon name="search" size={16}/><input key={params.get('q')??''} aria-label="Search tickets" name="q" defaultValue={params.get('q')??''} placeholder="Search tickets"/></div><select aria-label="Status" name="status" defaultValue={status??'all'} key={'status-'+status}><option value="all">All statuses</option>{['open','in_progress','resolved','closed'].map(s=><option value={s} key={s}>{s.replaceAll('_',' ')}</option>)}</select><select aria-label="Priority" name="priority" defaultValue={params.get('priority')??'all'} key={'priority-'+params.get('priority')}><option value="all">All priorities</option>{['critical','high','normal','low'].map(s=><option value={s} key={s}>{s}</option>)}</select><select aria-label="Sort tickets" name="sort" defaultValue={params.get('sort')??'priority'} key={'sort-'+params.get('sort')}><option value="priority">Priority</option><option value="created">Newest created</option><option value="updated">Last updated</option><option value="id">ID</option><option value="summary">Subject A–Z</option></select><input type="hidden" name="density" value={density}/>{params.get('clientId')&&<input type="hidden" name="clientId" value={params.get('clientId')!}/>}<button className="button" type="submit">Apply</button><Link className="text-link" href="/tickets">Clear</Link><select className="density-control" aria-label="Row density" value={density} onChange={e=>change(e.target.value,'density')}><option value="compact">Compact rows</option><option value="comfortable">Comfortable rows</option></select></form>
      {error?<ErrorState retry={()=>mutate()} message={error.message}/>:isLoading?<LoadingRows/>:data&&!data.data.length?<Empty title="No tickets in this view" detail="Choose another view or clear the filters."/>:data&&<TicketTable tickets={data.data} columns={columns} comfortable={density==='comfortable'} onSort={sort=>change(sort,'sort')}/>}
      <div className="table-footer"><span>{data?.total??'—'} matching tickets</span><div><button className="button" disabled={page<=1} onClick={()=>change(String(page-1),'page')}>Previous</button><span>Page {page}</span><button className="button" disabled={!data||page*data.limit>=data.total} onClick={()=>change(String(page+1),'page')}>Next</button></div></div><div className="queue-footnote">Read only. Asset, technician and SLA columns are available under Columns; their values are not recorded.</div>
    </div>
  </div>;
}

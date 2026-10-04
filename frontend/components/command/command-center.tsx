'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { actionQueue, type Snapshot } from '../../lib/model';
import { ActivityRows, Empty, formatDate, State } from '../primitives';
import { TicketTable } from '../tables/tickets';
import { Icon } from '../shell/icon';

export function CommandCenter({data}:{data:Snapshot}) {
  const view=useSearchParams().get('view')??'all';
  const [search,setSearch]=useState('');
  const all=actionQueue(data);
  const queue=all.filter(a=>(view==='decisions'?a.rank===0:view==='attention'?a.rank===1||a.rank===2:true)&&`${a.title} ${a.context} ${a.reason}`.toLowerCase().includes(search.toLowerCase()));
  const stats=data.stats;
  const pending=data.interactions.filter(i=>i.status==='open').length;
  const views=[{key:'all',name:'All work',count:stats?stats.openTickets+stats.waitingInput+stats.automationAttention:all.length},{key:'tickets',name:'Open tickets',count:stats?.openTickets??data.tickets.length},{key:'decisions',name:'Waiting for input',count:stats?.waitingInput??pending},{key:'attention',name:'Automation exceptions',count:stats?.automationAttention??0},{key:'activity',name:'Recent activity',count:null}];
  const selected=views.find(v=>v.key===view)??views[0];
  return <div className="queue-layout">
    <aside className="queue-navigation" aria-label="Work queues">
      <h2>Work queues</h2>
      {views.map(v=><Link href={v.key==='all'?'/':`/?view=${v.key}`} className={view===v.key?'selected':''} aria-current={view===v.key?'page':undefined} key={v.key}><span>{v.name}</span>{v.count!==null&&<span className="queue-count">{v.count}</span>}</Link>)}
      <div className="queue-group"><h3>Service overview</h3><dl><dt>Completed tickets</dt><dd>{stats?.completedTickets??'—'}</dd><dt>SLA tracking</dt><dd>Unavailable</dd></dl><Link href="/automations">Automation monitor <Icon name="arrow" size={14}/></Link></div>
    </aside>
    <div className="queue-workspace">
      <div className="queue-heading"><div><h2>{selected.name}</h2><span>{view==='activity'?'Recorded backend events':`${selected.count??queue.length} items`}</span></div><Link href="/tickets" className="button">Browse all tickets</Link></div>
      {!!stats?.automationAttention&&view!=='attention'&&<div className="attention-strip"><Icon name="info" size={15}/><Link href="/?view=attention">{stats.automationAttention} automation {stats.automationAttention===1?'requires':'require'} attention</Link><Link href="/automations">View details →</Link></div>}
      {view==='activity'?<div className="queue-activity"><ActivityRows events={data.activity??[]} limit={100}/></div>:view==='tickets'?<><TicketTable tickets={data.tickets.filter(t=>['open','in_progress'].includes(t.status))}/>{!data.tickets.length&&<Empty title="No tickets available" detail="Tickets appear here after the intake pipeline creates them."/>}</>:<>
        <div className="queue-controls"><div className="search-input"><Icon name="search" size={16}/><input aria-label="Search work queue" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search this queue"/></div><span>Priority, then oldest first</span></div>
        <div className="table-scroll"><table className="data-table work-queue-table"><thead><tr><th>Subject</th><th>Customer</th><th>Queue</th><th>Received</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{queue.map(a=><tr key={a.id}><td><Link className="ticket-subject" href={a.href}>{a.title}</Link><span className="queue-reason">{a.reason}</span></td><td>{a.context==='Customer not resolved'?<span className="unavailable">Not identified</span>:a.context}</td><td><State value={a.tag==='Critical'?'critical':a.rank===0?'waiting_input':a.rank<3?'needs_attention':'open'}/></td><td className="nowrap">{formatDate(a.time)}</td><td><Link href={a.href} aria-label={`Open ${a.title}`}><Icon name="arrow" size={16}/></Link></td></tr>)}</tbody></table></div>
        {!queue.length&&<Empty title="No items in this queue" detail={data.source==='live'?'Choose another queue or clear the search.':'Reconnect to load current work.'}/>}
      </>}
      <div className="queue-footnote">{view==='activity'?'Events reflect recorded timestamps.':`Queue preview contains up to 200 records per source. Ticket lists provide the full paginated history.`}</div>
    </div>
  </div>;
}

'use client';
import Link from 'next/link';
import { useSearchParams,useRouter } from 'next/navigation';
import { type Customer,type Contact,type Ticket } from '../../lib/model';
import { useApi } from '../../lib/queries';
import { Empty,ErrorState,formatDate,LoadingRows,Section,State } from '../primitives';
import { TicketTable } from '../tables/tickets';
import { Icon } from '../shell/icon';
type Client=Customer&{openTickets:number;contactCount:number};
type ClientsPage={data:Client[];total:number;page:number;limit:number};
export function Customers() {
  const params=useSearchParams();const router=useRouter();
  const {data,error,isLoading,mutate}=useApi<ClientsPage>(`/api/v1/clients?${params}`);
  function page(n:number){const next=new URLSearchParams(params);next.set('page',String(n));router.push(`/customers?${next}`);}
  return <><form className="filter-toolbar" action="/customers" method="get"><div className="search-input"><Icon name="search" size={15}/><input name="q" aria-label="Search customers" placeholder="Search company, contact or email" defaultValue={params.get('q')??''} key={params.get('q')}/></div><button className="button small">Search</button><Link className="text-link" href="/customers">Reset</Link></form>{error?<ErrorState retry={()=>mutate()} message={error.message}/>:isLoading?<LoadingRows/>:data&&!data.data.length?<Empty title="No customers yet" detail="Client records appear after the intake workflow resolves and confirms the customer."/>:data&&<div className="table-scroll"><table className="data-table"><thead><tr><th>Customer</th><th>Type</th><th>Status</th><th>Contacts</th><th>Open work</th><th>Created</th></tr></thead><tbody>{data.data.map(c=><tr key={c.id}><td><Link className="table-primary" href={`/customers/${c.id}`}>{c.name}</Link></td><td>{c.kind}</td><td><State value={c.active?'active':'inactive'}/></td><td className="numeric">{c.contactCount}</td><td className="numeric">{c.openTickets}</td><td className="mono nowrap">{formatDate(c.createdAt)}</td></tr>)}</tbody></table></div>}<div className="table-footer"><span>{data?.total??'—'} customers</span><div><button className="button small" disabled={!data||data.page<=1} onClick={()=>page((data?.page??1)-1)}>Previous</button><span>Page {data?.page??1}</span><button className="button small" disabled={!data||data.page*data.limit>=data.total} onClick={()=>page((data?.page??1)+1)}>Next</button></div></div></>;
}
export function CustomerDetail({id}:{id:string}) {
  const {data,error,isLoading,mutate}=useApi<{client:Client;contacts:Contact[];tickets:Ticket[];historyLimit:number}>(`/api/v1/clients/${id}`);
  if(error)return <ErrorState retry={()=>mutate()} message={error.status===404?'Customer not found':error.message}/>;
  if(isLoading||!data)return <LoadingRows count={8}/>;
  const {client:c,contacts,tickets}=data;
  return <><div className="record-header"><Link className="text-link" href="/customers">← Customers</Link><h1>{c.name}</h1><State value={c.active?'active':'inactive'}/><span>{c.openTickets} open tickets</span><span>{contacts.find(x=>x.active)?.name??'No named main contact'}</span></div><div className="customer-panes"><aside><Section title="Contacts">{contacts.map(x=><div className="contact-row" key={x.id}><strong>{x.name??'Unnamed contact'}</strong><a href={`mailto:${x.email}`}>{x.email}</a><State value={x.active?'active':'inactive'}/></div>)}{!contacts.length&&<Empty title="No contacts" detail="No contact records were returned for this client."/>}</Section><Section title="Customer record"><dl className="property-list"><dt>Type</dt><dd>{c.kind}</dd><dt>Created</dt><dd>{formatDate(c.createdAt)}</dd><dt>Assets</dt><dd>Unsupported</dd><dt>Contracts / SLA</dt><dd>Not recorded</dd></dl></Section></aside><div><Section title="Current work" meta={<span className="section-meta">{c.openTickets} total open · latest {data.historyLimit} records loaded</span>}><TicketTable tickets={tickets.filter(t=>['open','in_progress'].includes(t.status))}/></Section><Section title="Ticket history" meta={<Link className="text-link" href={`/tickets?clientId=${id}`}>All customer tickets</Link>}><TicketTable tickets={tickets}/></Section><Section title="Service context"><div className="capability-rows"><div><strong>Assets & repair history</strong><span>Not supported in deployed schema</span></div><div><strong>Recurring issues</strong><span>No verified pattern data available</span></div><div><strong>Service timeline</strong><span>Ticket timestamps are available; notes and audit events are not recorded</span></div></div></Section></div></div></>;
}

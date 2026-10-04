'use client';
import Link from 'next/link';
import { useEffect,useRef,useState } from 'react';
import { type Snapshot,searchRecords } from '../../lib/model';
import { useApi } from '../../lib/queries';
import { CommandCenter } from '../command/command-center';
import { Tickets } from '../tables/tickets';
import { TicketWorkspace } from '../ticket/workspace';
import { Customers,CustomerDetail } from '../customer/customers';
import { Automations } from '../automation/automations';
import { Empty,formatDate,Section } from '../primitives';
import { Icon } from './icon';
const navigation=[['/','Command Center','command'],['/tickets','Tickets','ticket'],['/customers','Customers','people'],['/assets','Assets','device'],['/schedule','Schedule','calendar'],['/knowledge','Knowledge','book'],['/business','Business','chart'],['/automations','Automations','bolt']] as const;
const tools=[['/migration','Migration','upload'],['/settings','Settings','settings']] as const;
export function AppShell({data:initial,path}:{data:Snapshot;path:string[]}) {
  const {data=initial,error,isValidating,mutate}=useApi<Snapshot>('/api/v1/snapshot',initial);
  const [collapsed,setCollapsed]=useState(false);const [mobileOpen,setMobileOpen]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);const [query,setQuery]=useState('');
  const active=path[0]??'';const route=`/${path.join('/')}`;
  const title=[...navigation,...tools].find(x=>x[0]===`/${active}`)?.[1]??'Workspace';
  useEffect(()=>{try{setCollapsed(localStorage.getItem('relay.sidebarCollapsed')==='true');}catch{}},[]);
  function collapse(){const value=!collapsed;setCollapsed(value);localStorage.setItem('relay.sidebarCollapsed',String(value));}
  function openSearch(){setQuery('');dialog.current?.showModal();}
  useEffect(()=>{const handler=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(dialog.current?.open)dialog.current.close();else openSearch();}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[]);
  useEffect(()=>{setMobileOpen(false);dialog.current?.close();},[route]);
  const results=query?searchRecords(data,query):[];
  const navResults=[...navigation,...tools].filter(x=>x[1].toLowerCase().includes(query.toLowerCase()));
  const live=!error&&data.source==='live';
  return <div className={`console ${collapsed?'sidebar-collapsed':''}`}>
    <a className="skip-link" href="#workspace-main">Skip to work</a>
    <aside className={`app-sidebar ${mobileOpen?'mobile-open':''}`}>
      <div className="app-brand"><Link href="/" aria-label="Relay Command Center"><span className="app-logo"><Icon name="command" size={16}/></span><strong>Relay</strong></Link><button aria-label={collapsed?'Expand sidebar':'Collapse sidebar'} className="sidebar-toggle" onClick={collapse}><Icon name="menu" size={14}/></button></div>
      <div className="sidebar-context"><span className="context-marker"/>Service workspace</div>
      <nav aria-label="Main navigation">{navigation.map(([href,name,icon])=><Link href={href} key={href} title={collapsed?name:undefined} aria-label={name} aria-current={href===`/${active}`?'page':undefined} className={`sidebar-item ${href===`/${active}`?'active':''}`}><Icon name={icon} size={16}/><span>{name}</span>{href==='/tickets'&&data.stats&&<small>{data.stats.openTickets}</small>}</Link>)}</nav>
      <div className="sidebar-tools"><span className="sidebar-caption">TOOLS</span>{tools.map(([href,name,icon])=><Link href={href} key={href} aria-label={name} title={collapsed?name:undefined} className={`sidebar-item ${href===`/${active}`?'active':''}`}><Icon name={icon} size={16}/><span>{name}</span></Link>)}</div><div className="sidebar-foot"><span className="session-icon">R</span><span>Local observer<small>Read-only</small></span></div>
    </aside>
    {mobileOpen&&<button className="navigation-scrim" aria-label="Close navigation" onClick={()=>setMobileOpen(false)}/>}
    <div className="console-content"><header className="app-topbar"><div><button className="icon-button mobile-toggle" aria-label="Open navigation" aria-expanded={mobileOpen} onClick={()=>setMobileOpen(!mobileOpen)}><Icon name="menu" size={16}/></button><span className="workspace-crumb">Service workspace</span><span className="crumb-separator">/</span><strong>{title}</strong></div><div><button className="command-trigger" aria-label="Search workspace" onClick={openSearch}><Icon name="search" size={14}/><span>Search</span><kbd>Ctrl K</kbd></button><span className={`connection-state ${live?'connected':'connection-error'}`}><i/>{live?'Connected':'Backend unavailable'}</span><button aria-label="Refresh backend data" className={`icon-button ${isValidating?'refreshing':''}`} onClick={()=>mutate()}><Icon name="refresh" size={15}/></button></div></header>
      <main id="workspace-main" className="workspace-main">
        <div className="page-titlebar"><div><h1>{title}</h1>{!path[1]&&<span>{active==='tickets'?'All service work':active==='automations'?'Persistent service state':active==='customers'?'Client records':'Read-only workspace'}</span>}</div><div className="page-tools"><span>{isValidating?'Updating…':`Updated ${formatDate(data.capturedAt)}`}</span><span className="read-mode">Read only</span></div></div>
        {(!live)&&<div role="alert" className="backend-error"><Icon name="info" size={16}/><strong>Backend unavailable</strong><span>{data.message??'The last snapshot could not be refreshed.'}</span><button className="button small" onClick={()=>mutate()}>Retry</button>{data.source==='live'&&<span>Showing last successful snapshot.</span>}</div>}
        {data.truncated&&<div className="inline-note">Action queue and record previews are bounded to 200 rows. Summary and service counts query the full database; ticket/customer lists are paginated.</div>}
        {!active&&<CommandCenter data={data}/>}
        {active==='tickets'&&(path[1]?<TicketWorkspace id={path[1]} snapshot={data}/>:<Tickets snapshot={data}/>)}
        {active==='customers'&&(path[1]?<CustomerDetail id={path[1]}/>:<Customers/>)}
        {active==='automations'&&<Automations data={data}/>}
        {active==='settings'&&<Settings source={data.source}/>}
        {['assets','schedule','knowledge','business','migration'].includes(active)&&<Unsupported page={active}/>}
      </main><footer className="console-footer"><span>{live?'PostgreSQL · read-only snapshot':'No current backend connection'}</span><span>Polls every 15s while visible · Madrid time</span></footer>
    </div>
    <dialog className="command-palette" ref={dialog} aria-labelledby="search-title" onClick={e=>{if(e.target===e.currentTarget)dialog.current?.close();}}><div className="palette-input"><Icon name="search" size={18}/><label id="search-title" htmlFor="command-query" className="sr-only">Search workspace</label><input id="command-query" autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Ticket ID, summary, customer, email…"/><button className="icon-button" aria-label="Close search" onClick={()=>dialog.current?.close()}><Icon name="close" size={16}/></button></div><div className="palette-items">{results.length>0&&<div className="palette-caption">Records in current snapshot</div>}{results.map(x=><Link key={x.id} href={x.href} onClick={()=>dialog.current?.close()}><Icon name="ticket" size={15}/><span><strong>{x.title}</strong><small>{x.subtitle}</small></span><Icon name="arrow" size={13}/></Link>)}{navResults.length>0&&<div className="palette-caption">Navigate</div>}{navResults.map(([href,name,icon])=><Link key={href} href={href} onClick={()=>dialog.current?.close()}><Icon name={icon} size={15}/><span>{name}</span></Link>)}{!results.length&&!navResults.length&&<Empty title="No matching records" detail="Open Tickets or Customers to search the full database. Assets are not yet supported."/>}</div><div className="palette-help"><kbd>Tab</kbd> navigate · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</div></dialog>
  </div>;
}
function Unsupported({page}:{page:string}) {
  const notes:Record<string,string>={assets:'No asset table or ticket-to-asset relationship exists in the deployed database.',schedule:'Technician availability and bookings are not stored in the deployed backend.',knowledge:'No published knowledge articles or reviewed resolution model is available.',business:'SLA, labor costs, quotes and billing data are not available.',migration:'Import mappings, provenance and guarded import execution are not implemented.'};
  return <Section title="Backend capability"><Empty title="Not supported by the current backend" detail={notes[page]}/>{page==='assets'&&<div className="table-scroll"><table className="data-table"><thead><tr>{['Asset','Model','Serial','Customer','Location','OS','Warranty'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody><tr><td colSpan={7} className="muted-cell">No asset records available.</td></tr></tbody></table></div>}</Section>;
}
function Settings({source}:{source:string}) {return <Section title="Connection & access"><dl className="settings-properties"><dt>Backend state</dt><dd>{source}</dd><dt>Application API</dt><dd>Tickets, clients, interactions, activity, automation health</dd><dt>Local transport</dt><dd>Docker exec → PostgreSQL socket → read-only transaction, session authorized as ticket_owner</dd><dt>Access boundary</dt><dd>Loopback host, same-origin requests, no forwarded access. Network deployment requires authenticated pg transport with a dedicated reader.</dd><dt>Writes</dt><dd>Unavailable; no worker, workflow or database mutation is exposed.</dd><dt>Live updates</dt><dd>15-second polling while visible; explicit failure and retry.</dd></dl></Section>;}

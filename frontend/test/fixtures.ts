import { emptySnapshot,type Snapshot } from '../lib/model';
// Test-only records. This module is never imported by application/runtime code.
export function fixtureSnapshot():Snapshot {
  const s=emptySnapshot('live',null);
  s.customers=[{id:'test-client',name:'Test Client',kind:'company',active:true,createdAt:'2026-10-01T10:00:00Z'}];
  s.contacts=[{id:'test-contact',customerId:'test-client',name:'Test Contact',email:'unit@example.invalid',active:true}];
  s.tickets=[['1','critical','open'],['2','normal','open'],['3','normal','in_progress'],['4','normal','resolved']].map(([n,p,status])=>({id:`test-ticket-${n}`,number:n,intakeId:`test-intake-${n}`,customerId:'test-client',contactId:'test-contact',summary:`Test issue ${n}`,description:'Unit fixture',category:'hardware',priority:p as 'critical'|'normal',status:status as 'open'|'in_progress'|'resolved',createdAt:`2026-10-0${n}T10:00:00Z`,updatedAt:'2026-10-04T10:00:00Z'}));
  s.intakes=[{id:'test-intake-pending',number:'5',state:'awaiting_email',summary:'Test operator request',transcript:null,customerId:null,createdAt:'2026-10-04T10:00:00Z',updatedAt:'2026-10-04T10:00:00Z',categorySuggestion:null,prioritySuggestion:null,businessImpact:null,missingInformation:[]}];
  s.interactions=[{id:'test-interaction',intakeId:'test-intake-pending',kind:'email',status:'open',createdAt:'2026-10-04T10:00:00Z'}];
  s.deliveries=[{id:'test-delivery',intakeId:'test-intake-pending',kind:'prompt',status:'sent',attempts:1,updatedAt:'2026-10-04T10:00:00Z'}];
  return s;
}

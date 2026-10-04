import { NextResponse } from 'next/server';
import { response } from '../../../../lib/api/response';
import * as service from '../../../../lib/api/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ resource: string[] }> }) {
  const { resource } = await params;
  const [entity,id] = resource;
  const query = new URL(request.url).searchParams;
  if (resource.length > 2) return NextResponse.json({ error:'Not found' },{ status:404 });
  if (entity==='tickets') return response(() => id ? service.ticket(id) : service.tickets(query));
  if (entity==='clients') return response(() => id ? service.client(id) : service.clients(query));
  if (entity==='interactions' && !id) return response(() => service.interactions(query));
  if (entity==='activity' && !id) return response(service.activity);
  if (entity==='automation-health' && !id) return response(service.automationHealth);
  if (entity==='assets') return NextResponse.json({ supported:false,data:[],reason:'Assets are not present in the deployed backend.' },{ status:501,headers:{'Cache-Control':'no-store'} });
  return NextResponse.json({ error:'Not found' },{status:404});
}

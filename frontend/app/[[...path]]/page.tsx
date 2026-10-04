import { notFound } from 'next/navigation';
import { loadSnapshot } from '../../lib/data';
import { Workspace } from '../../components/workspace';
export const dynamic = 'force-dynamic';
const pages = ['tickets', 'customers', 'assets', 'schedule', 'knowledge', 'business', 'automations', 'migration', 'settings'];
export default async function Page({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  if (path.length > 2 || (path[0] && !pages.includes(path[0])) || (path.length === 2 && !['tickets', 'customers', 'assets'].includes(path[0]))) notFound();
  const data = await loadSnapshot();
  return <Workspace data={data} path={path} />;
}

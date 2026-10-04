import Link from 'next/link';
export default function NotFound() { return <main className="standalone"><span className="eyebrow">RELAY / RECORD UNAVAILABLE</span><h1>This record is not in the loaded workspace.</h1><p>It may be outside the bounded snapshot, or the connection may be unavailable.</p><Link className="button primary" href="/">Return to Command Center</Link></main>; }

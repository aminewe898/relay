'use client';
export default function ErrorPage({ reset }: { reset: () => void }) { return <main className="standalone"><h1>The workspace could not load.</h1><p>Refresh the snapshot to try again. No action has been submitted.</p><button className="button primary" onClick={reset}>Try again</button></main>; }

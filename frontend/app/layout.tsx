import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Relay · Service workspace', description: 'An action-driven workspace for IT service teams.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}

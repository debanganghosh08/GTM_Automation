import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: {
    default: 'GTM Autopilot',
    template: '%s · GTM Autopilot',
  },
  description:
    '30,000 outbound email credits and a done-for-you GTM strategy. Leads sourced and verified, copy written, mailboxes warmed, campaigns sent.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-ink">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>
        <Nav />
        <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6">
          {children}
        </main>
        <footer className="mx-auto max-w-6xl px-4 py-8 text-[11px] text-faint">
          GTM Autopilot by SparqLabs. 1 credit = 1 email sent. Warm-up takes 7 days and cannot be skipped.
        </footer>
      </body>
    </html>
  );
}

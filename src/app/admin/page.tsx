import type { Metadata } from 'next';
import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import type { User } from '@/lib/contracts';
import { Notice } from '@/components/Notice';
import { AdminPanel } from '@/components/views/AdminPanel';

export const metadata: Metadata = { title: 'Admin' };
export const dynamic = 'force-dynamic';

/**
 * Admin console. Gated server-side on `is_admin`; the API routes enforce it
 * again, this is only so a non-admin never sees the shell.
 */
export default async function AdminPage() {
  let user: User | null = null;
  let authError: string | null = null;
  try {
    user = await currentUser();
  } catch (err) {
    authError = err instanceof Error ? err.message : 'Could not read the session';
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Admin</h1>
        <p className="mt-1 text-sm text-muted">First-campaign approvals, accounts with credits and cost, and the job queue.</p>
      </div>

      {authError ? (
        <Notice tone="danger" title="Could not check your session">
          {authError}
        </Notice>
      ) : !user ? (
        <Notice tone="warn" title="Sign in required">
          <Link href="/login" className="font-medium underline">
            Sign in
          </Link>{' '}
          with an admin account to use this page.
        </Notice>
      ) : !user.is_admin ? (
        <Notice tone="warn" title="Admins only">
          Your account ({user.email}) is not an admin. Nothing here is available to you.
        </Notice>
      ) : (
        <AdminPanel adminEmail={user.email} />
      )}
    </div>
  );
}

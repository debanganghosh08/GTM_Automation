import type { Metadata } from 'next';
import { Card } from '@/components/Card';

export const metadata: Metadata = {
  title: 'Unsubscribed',
  robots: { index: false, follow: false },
};

/** Public confirmation shown after an unsubscribe link (GET /api/unsubscribe?token=) is used. */
export default function UnsubscribedPage() {
  return (
    <div className="mx-auto max-w-md">
      <Card title="You have been unsubscribed">
        <div className="flex flex-col gap-3 text-sm text-muted">
          <p className="text-ink">
            <span aria-hidden="true" className="mr-1 text-ok">
              ✓
            </span>
            Your address has been added to the suppression list. You will not receive further emails from this sender.
          </p>
          <p>This takes effect immediately. Any messages already queued to you are cancelled before they send.</p>
          <p>
            If you believe you reached this page by mistake, reply to the original email and the sender can address it
            directly. Nothing else is required from you.
          </p>
        </div>
      </Card>
    </div>
  );
}

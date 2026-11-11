import type { Metadata } from 'next';
import { JourneySteps } from '@/components/JourneySteps';
import { DashboardView } from '@/components/views/DashboardView';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <JourneySteps current={6} />
      <div>
        <h1 className="text-xl font-semibold">Results</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Numbers come from the sending platform and are refreshed on a schedule. Hover the ? next to any rate for its
          exact definition; tools disagree on these.
        </p>
      </div>
      <DashboardView />
    </div>
  );
}

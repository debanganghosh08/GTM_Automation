import type { Metadata } from 'next';
import { JourneySteps } from '@/components/JourneySteps';
import { InfrastructurePanel } from '@/components/views/InfrastructurePanel';

export const metadata: Metadata = { title: 'Domain and warm-up' };

export default function InfrastructurePage() {
  return (
    <div className="flex flex-col gap-6">
      <JourneySteps current={4} />
      <div>
        <h1 className="text-xl font-semibold">Sending domain and warm-up</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Outbound goes from a separate domain so your main domain&apos;s reputation is never at risk. Connect one you
          own or buy one, add the DNS records, verify, and the 7-day warm-up starts.
        </p>
      </div>
      <InfrastructurePanel />
    </div>
  );
}

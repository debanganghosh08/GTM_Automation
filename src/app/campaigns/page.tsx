import type { Metadata } from 'next';
import { JourneySteps } from '@/components/JourneySteps';
import { CampaignsList } from '@/components/views/CampaignsList';

export const metadata: Metadata = { title: 'Campaigns' };

export default function CampaignsPage() {
  return (
    <div className="flex flex-col gap-6">
      <JourneySteps current={5} />
      <div>
        <h1 className="text-xl font-semibold">Campaigns</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Each campaign is one segment, one angle, one lead list and one sequence. Open a campaign to review its leads
          and copy before it sends.
        </p>
      </div>
      <CampaignsList />
    </div>
  );
}

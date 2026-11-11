import type { Metadata } from 'next';
import { JourneySteps } from '@/components/JourneySteps';
import { CampaignReview } from '@/components/views/CampaignReview';

export const metadata: Metadata = { title: 'Review campaign' };

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <JourneySteps current={5} />
      <CampaignReview id={id} />
    </div>
  );
}

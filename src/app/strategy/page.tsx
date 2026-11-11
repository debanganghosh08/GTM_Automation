import type { Metadata } from 'next';
import { JourneySteps } from '@/components/JourneySteps';
import { StrategyEditor } from '@/components/views/StrategyEditor';

export const metadata: Metadata = { title: 'Your GTM strategy' };

export default function StrategyPage() {
  return (
    <div className="flex flex-col gap-6">
      <JourneySteps current={3} />
      <div>
        <h1 className="text-xl font-semibold">Your GTM strategy</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Drafted from your questionnaire and website. Every field is editable. Read the assumptions block first: it
          lists what we could not determine from your inputs and guessed at.
        </p>
      </div>
      <StrategyEditor />
    </div>
  );
}

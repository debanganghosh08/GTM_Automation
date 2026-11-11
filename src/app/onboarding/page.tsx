import type { Metadata } from 'next';
import { JourneySteps } from '@/components/JourneySteps';
import { OnboardingForm } from '@/components/views/OnboardingForm';

export const metadata: Metadata = { title: 'Questionnaire' };

export default function OnboardingPage() {
  return (
    <div className="flex flex-col gap-6">
      <JourneySteps current={2} />
      <div>
        <h1 className="text-xl font-semibold">Tell us what you sell and who buys it</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Ten minutes here saves a week of back and forth. We combine your answers with what we read on your website
          to draft the GTM strategy on the next screen. Everything is editable there.
        </p>
      </div>
      <OnboardingForm />
    </div>
  );
}

import type { Metadata } from 'next';
import { Card } from '@/components/Card';
import { AuthForm } from '@/components/views/AuthForm';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-sm">
      <Card title="Sign in" description="Use the email you signed up with.">
        <AuthForm mode="login" />
      </Card>
    </div>
  );
}

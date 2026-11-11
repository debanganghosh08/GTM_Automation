import type { Metadata } from 'next';
import { Card } from '@/components/Card';
import { Notice } from '@/components/Notice';
import { AuthForm } from '@/components/views/AuthForm';

export const metadata: Metadata = { title: 'Register' };

export default function RegisterPage() {
  return (
    <div className="mx-auto max-w-sm">
      <Card title="Create an account" description="Plain registration, without a partner code.">
        <Notice tone="info" className="mb-3">
          Accounts created here start without credits. To get the 30,000-credit launch offer, sign up from the landing
          page with your partner link.
        </Notice>
        <AuthForm mode="register" />
      </Card>
    </div>
  );
}

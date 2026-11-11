/**
 * Mock verifier. The verdict is a pure function of the address, so a lead that
 * was `risky` yesterday is `risky` today and re-verification is a no-op.
 */

import type { LeadVerification, VerificationProvider, VerificationResult } from '../../lib/contracts';
import { fnv1a } from './hash';

export function mockVerdict(email: string): LeadVerification {
  const bucket = fnv1a(`verify:${email.trim().toLowerCase()}`) % 100;
  if (bucket < 85) return 'valid';
  if (bucket < 90) return 'invalid';
  if (bucket < 95) return 'risky';
  return 'catch_all';
}

export class MockVerificationProvider implements VerificationProvider {
  readonly name = 'mock-truelist';

  async verify(emails: string[]): Promise<VerificationResult[]> {
    return emails.map((email) => ({ email, status: mockVerdict(email), provider: this.name }));
  }
}

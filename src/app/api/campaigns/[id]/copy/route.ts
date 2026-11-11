/**
 * GET /api/campaigns/:id/copy — the latest copy version with its compliance report.
 * PUT /api/campaigns/:id/copy — save edited steps as a new version.
 *
 * Compliance is recomputed here, server-side, from the submitted steps and the
 * account's sending name. Whatever the client sends about compliance (a
 * `compliance` object, `compliance_passed: true`) is rejected by the strict
 * schema, so a forged "passed" can never reach gate 3 (SPEC §5).
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, jsonBody, notFound, ok, route, unauthorized } from '@/lib/api';
import { checkCompliance } from '@/lib/compliance';
import type { ComplianceReport, CopyStep } from '@/lib/contracts';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const COPY_COLS =
  'id, campaign_id, version, steps, model, edited_by_user, compliance, compliance_passed, approved_at, created_at';

interface CopyRow {
  id: string;
  campaign_id: string;
  version: number;
  steps: CopyStep[];
  model: string | null;
  edited_by_user: boolean;
  compliance: ComplianceReport | null;
  compliance_passed: boolean;
  approved_at: string | null;
  created_at: string;
}

const Step = z
  .object({
    step: z.number().int().min(1).max(20),
    delay_days: z.number().int().min(0).max(90),
    subject: z.string().max(300),
    body: z.string().max(8000),
    note: z.string().max(2000).optional(),
  })
  .strict();

// `.strict()` rejects any key not listed. The client's `compliance` and
// `compliance_passed` are stripped before this runs (see PUT) so they are
// neither trusted nor a reason to fail the save.
const Body = z.object({ steps: z.array(Step).min(1).max(10) }).strict();

export const GET = route<Ctx>(async (req: Request, ctx) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();

  const db = await getDb();
  const campaign = await db.query<{ id: string }>(
    `select id from campaigns where id = $1 and account_id = $2`, [id, user.account_id],
  );
  if (!campaign.rows[0]) return notFound();

  const copy = await db.query<CopyRow>(
    `select ${COPY_COLS} from campaign_copy where campaign_id = $1 and account_id = $2
     order by version desc limit 1`,
    [id, user.account_id],
  );
  return ok({ copy: copy.rows[0] ?? null });
});

export const PUT = route<Ctx>(async (req: Request, ctx) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();

  const db = await getDb();
  const campaign = await db.query<{ id: string; status: string }>(
    `select id, status::text as status from campaigns where id = $1 and account_id = $2`,
    [id, user.account_id],
  );
  if (!campaign.rows[0]) return notFound();

  const raw = await jsonBody<unknown>(req);
  if (raw === null || typeof raw !== 'object') return fail('Invalid JSON body', 400, 'invalid_body');
  // A client round-tripping a copy record may echo its compliance fields back.
  // They are discarded here, unread; the report below is the only one stored.
  const { compliance: _c, compliance_passed: _p, ...untrusted } = raw as Record<string, unknown>;
  void _c; void _p;
  const parsed = Body.safeParse(untrusted);
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400, 'invalid_body');
  }
  const steps: CopyStep[] = parsed.data.steps.map((s) => ({
    step: s.step,
    delay_days: s.delay_days,
    subject: s.subject,
    body: s.body,
    ...(s.note !== undefined ? { note: s.note } : {}),
  }));

  const stepNumbers = new Set(steps.map((s) => s.step));
  if (stepNumbers.size !== steps.length) return fail('Step numbers must be unique', 400, 'invalid_body');

  const profile = await db.query<{ sending_name: string | null }>(
    `select sending_name from onboarding_profiles where account_id = $1`, [user.account_id],
  );
  const report = checkCompliance({ steps }, { sendingName: profile.rows[0]?.sending_name ?? null });

  const latest = await db.query<{ version: number; model: string | null }>(
    `select version, model from campaign_copy where campaign_id = $1 and account_id = $2
     order by version desc limit 1`,
    [id, user.account_id],
  );
  const version = (latest.rows[0]?.version ?? 0) + 1;

  const saved = await db.tx(async (t) => {
    const ins = await t.query<CopyRow>(
      `insert into campaign_copy
         (campaign_id, account_id, version, steps, model, prompt_version, edited_by_user, compliance, compliance_passed)
       values ($1, $2, $3, $4::jsonb, $5, 'user-edit', true, $6::jsonb, $7)
       returning ${COPY_COLS}`,
      [id, user.account_id, version, JSON.stringify(steps), latest.rows[0]?.model ?? null,
        JSON.stringify(report), report.passed],
    );
    if (campaign.rows[0]?.status === 'awaiting_copy') {
      await t.query(
        `update campaigns set status = 'awaiting_review'::campaign_status, updated_at = now()
         where id = $1 and account_id = $2 and status = 'awaiting_copy'`,
        [id, user.account_id],
      );
    }
    await t.query(
      `insert into events (account_id, actor, type, subject, detail)
       values ($1, 'customer', 'copy.edited', $2, $3::jsonb)`,
      [user.account_id, id, JSON.stringify({
        version, user_id: user.id, compliance_passed: report.passed, errors: report.errors.length,
      })],
    );
    return ins.rows[0]!;
  });

  return ok({ copy: saved });
});

import { destroySession, sessionCookieOptions, tokenFromRequest } from '../../../../lib/auth';
import { ok, route } from '../../../../lib/api';

export const runtime = 'nodejs';

export const POST = route(async (req: Request) => {
  const token = tokenFromRequest(req);
  if (token) await destroySession(token);

  const response = ok({ signed_out: true });
  const cookie = sessionCookieOptions();
  response.cookies.set(cookie.name, '', { ...cookie, maxAge: 0 });
  return response;
});

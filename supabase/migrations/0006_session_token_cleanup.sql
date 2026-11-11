-- Backfill the session token hash, then stop relying on the plaintext column.
--
-- Written as a separate migration from 0003 so that a deploy sequence of
-- 0003 -> application update -> 0006 never invalidates a live session: during the
-- middle step both columns are populated and either is accepted.
--
-- The plaintext column is NOT dropped here. Drop it in a later migration once no
-- session issued by the previous version can still be valid (30 days), by running:
--   alter table sessions drop column token;

update sessions
   set token_hash = encode(sha256(token::bytea), 'hex')
 where token_hash is null;

-- Sessions issued before the absolute-expiry column existed get one, so no session
-- can be refreshed indefinitely.
update sessions
   set absolute_expires_at = expires_at
 where absolute_expires_at is null;

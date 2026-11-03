alter table identity_private.profiles add column if not exists account_id text;
create index if not exists profile_account on identity_private.profiles(tenant,account_id);
create index if not exists events_actor_time on identity_private.events(tenant,actor,created_at desc);
create or replace function public.identity_query(statements jsonb) returns jsonb
language plpgsql security invoker set search_path = identity_private, pg_temp as $$
declare item jsonb; q text; rendered text; args jsonb; idx int; pos int; rows jsonb; changes bigint; output jsonb := '[]'::jsonb;
begin
 if jsonb_typeof(statements) <> 'array' or jsonb_array_length(statements)>10 then raise exception 'Invalid batch'; end if;
 for item in select value from jsonb_array_elements(statements) loop
 q := item->>'sql'; args := item->'args';
 if not (q = any(array['DELETE FROM events WHERE tenant=? AND created_at<?','DELETE FROM profiles WHERE id=?','DELETE FROM sessions WHERE expires_at < ?','INSERT INTO configuration (key,payload) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload','INSERT INTO events (id,tenant,actor,action,payload,created_at) VALUES (?,?,?,?,?,?)','INSERT INTO events (id,tenant,actor,profile_id,action,payload,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM profiles WHERE id=? AND last_attempt=?)','INSERT INTO events (id,tenant,actor,profile_id,action,payload,created_at) VALUES (?,?,?,?,?,?,?)','INSERT INTO profiles (id,tenant,owner,document_key,data,biometric,media,created_at,updated_at,last_attempt) VALUES (?,?,?,?,?,?,?,?,?,?)','INSERT INTO profiles (id,tenant,owner,document_key,data,biometric,media,created_at,updated_at,last_attempt,account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)','SELECT media,status FROM profiles WHERE id=? AND tenant=? AND account_id=?','SELECT id,data,status,created_at,updated_at FROM profiles WHERE tenant=? AND account_id=? ORDER BY created_at DESC LIMIT 50','SELECT id,profile_id,action,payload,created_at FROM events WHERE tenant=? AND actor=? ORDER BY created_at DESC LIMIT 51 OFFSET ?','INSERT INTO sessions (id,token_hash,creator,mode,expires_at,status) VALUES (?,?,?,?,?,?)','INSERT OR IGNORE INTO events (id,tenant,actor,profile_id,action,payload,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM profiles WHERE id=? AND last_attempt=?)','SELECT * FROM profiles WHERE id=? AND tenant=?','SELECT * FROM profiles WHERE tenant=? AND document_key=?','SELECT * FROM profiles WHERE tenant=? AND document_key=? AND owner=? AND status=?','SELECT * FROM sessions WHERE token_hash=? AND claimant=? AND expires_at>? AND mode=? AND status IN (?,?)','SELECT * FROM sessions WHERE token_hash=? AND claimant=? AND expires_at>? AND status IN (?,?)','SELECT COUNT(*) AS total FROM profiles WHERE tenant=?','SELECT id,actor,profile_id,action,payload,created_at FROM events WHERE tenant=? ORDER BY created_at DESC LIMIT 100 OFFSET ?','SELECT id,data,status,failures,locked_until,update_allowed,created_at,updated_at,media FROM profiles WHERE tenant=? ORDER BY created_at DESC LIMIT 50 OFFSET ?','SELECT id,status,expires_at FROM sessions WHERE id=? AND creator=?','SELECT locked_until,status,owner FROM profiles WHERE id=? AND tenant=?','SELECT media,status FROM profiles WHERE id=? AND tenant=?','SELECT mode FROM sessions WHERE token_hash=? AND claimant=?','SELECT payload FROM configuration WHERE key=?','SELECT payload FROM events WHERE id=? AND actor=? AND profile_id=? AND action=?','SELECT payload,created_at,profile_id FROM events WHERE id=? AND actor=? AND tenant=? AND action=?','SELECT profile_id FROM events WHERE id=? AND actor=? AND action IN (?,?)','SELECT profiles.id FROM profiles JOIN events ON profiles.id=events.profile_id WHERE profiles.tenant=? AND events.actor=? AND events.action=? AND profiles.status=? ORDER BY events.created_at DESC LIMIT 1','UPDATE profiles SET data=?,biometric=?,media=?,update_allowed=0,version=version+1,updated_at=?,last_attempt=? WHERE id=? AND version=? AND update_allowed=1 AND status=?','UPDATE profiles SET failures=0,locked_until=0,version=version+1 WHERE id=?','UPDATE profiles SET failures=?,locked_until=?,version=version+1,last_attempt=? WHERE id=? AND version=? AND status=?','UPDATE profiles SET media=?,biometric=?,version=version+1 WHERE id=? AND version=?','UPDATE profiles SET status=?,version=version+1 WHERE id=?','UPDATE profiles SET update_allowed=1,version=version+1 WHERE id=?','UPDATE sessions SET claimant=?,status=? WHERE token_hash=? AND status=? AND expires_at>?','UPDATE sessions SET mode=?,status=?,expires_at=? WHERE id=? AND claimant=?','UPDATE sessions SET status=? WHERE id=?','UPDATE sessions SET status=?,expires_at=? WHERE id=?'])) then raise exception 'Statement is not allowlisted'; end if;
 rendered := ''; idx := 0;
 while position('?' in q)>0 loop
 pos := position('?' in q);
 rendered := rendered || left(q,pos-1) || quote_nullable(args->>idx);
 q := substring(q from pos+1); idx := idx+1;
 end loop;
 if idx <> jsonb_array_length(args) then raise exception 'Argument count mismatch'; end if;
 rendered := rendered || q;
 if rendered like 'SELECT %' then
 execute 'select coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) from (' || rendered || ') t' into rows;
 changes := 0;
 else
 if rendered like 'INSERT OR IGNORE %' then rendered := replace(rendered,'INSERT OR IGNORE','INSERT') || ' ON CONFLICT DO NOTHING'; end if;
 execute rendered;
 get diagnostics changes = row_count;
 rows := '[]'::jsonb;
 end if;
 output := output || jsonb_build_array(jsonb_build_object('results',rows,'meta',jsonb_build_object('changes',changes)));
 end loop;
 return output;
end $$;
revoke all on function public.identity_query(jsonb) from public, anon, authenticated;
grant execute on function public.identity_query(jsonb) to service_role;

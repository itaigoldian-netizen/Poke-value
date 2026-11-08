-- 2026-11-08: Add co-owner itay.goldian@gmail.com (verified account
-- b7569c9d-eb42-4c7d-ab0c-8ae81ac6ed25, email_confirmed, created 2026-11-08)
-- alongside existing owner itai.goldian@gmail.com
-- (b362f086-9c13-45c6-b890-d222459275b9). Both keep FULL owner rights.
-- Owner decision Nov8 16:20, explicitly confirmed 16:20:47 (WhatsApp).
-- Existing owner UUID is preserved everywhere; nothing is replaced.

-- 1. is_admin(): owner = either owner UUID, plus appointed admins as before.
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select auth.uid() in ('b362f086-9c13-45c6-b890-d222459275b9'::uuid,
                        'b7569c9d-eb42-4c7d-ab0c-8ae81ac6ed25'::uuid)
    or exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

-- 2. app_admins: only an owner may read/grant/revoke admins (unchanged shape).
DROP POLICY admins_owner_all ON public.app_admins;
CREATE POLICY admins_owner_all ON public.app_admins FOR ALL TO authenticated
  USING (auth.uid() in ('b362f086-9c13-45c6-b890-d222459275b9'::uuid,
                        'b7569c9d-eb42-4c7d-ab0c-8ae81ac6ed25'::uuid))
  WITH CHECK (auth.uid() in ('b362f086-9c13-45c6-b890-d222459275b9'::uuid,
                             'b7569c9d-eb42-4c7d-ab0c-8ae81ac6ed25'::uuid));

-- 3. articles: both owners may publish and delete articles.
DROP POLICY articles_owner_insert ON public.articles;
CREATE POLICY articles_owner_insert ON public.articles FOR INSERT
  WITH CHECK (auth.uid() in ('b362f086-9c13-45c6-b890-d222459275b9'::uuid,
                             'b7569c9d-eb42-4c7d-ab0c-8ae81ac6ed25'::uuid));
DROP POLICY articles_owner_delete ON public.articles;
CREATE POLICY articles_owner_delete ON public.articles FOR DELETE
  USING (auth.uid() in ('b362f086-9c13-45c6-b890-d222459275b9'::uuid,
                        'b7569c9d-eb42-4c7d-ab0c-8ae81ac6ed25'::uuid));

-- 4. community_trades: both owners moderate deal reports.
DROP POLICY trades_owner_all ON public.community_trades;
CREATE POLICY trades_owner_all ON public.community_trades FOR ALL
  USING (auth.uid() in ('b362f086-9c13-45c6-b890-d222459275b9'::uuid,
                        'b7569c9d-eb42-4c7d-ab0c-8ae81ac6ed25'::uuid))
  WITH CHECK (auth.uid() in ('b362f086-9c13-45c6-b890-d222459275b9'::uuid,
                             'b7569c9d-eb42-4c7d-ab0c-8ae81ac6ed25'::uuid));

-- 5. user_favorites: favorites stay a paid feature; BOTH owners are exempt.
-- The subscription clause is preserved verbatim from the original policy.
DROP POLICY favorites_own_insert ON public.user_favorites;
CREATE POLICY favorites_own_insert ON public.user_favorites FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id) AND (
    auth.uid() in ('b362f086-9c13-45c6-b890-d222459275b9'::uuid,
                   'b7569c9d-eb42-4c7d-ab0c-8ae81ac6ed25'::uuid)
    OR EXISTS (SELECT 1 FROM subscriptions s
               WHERE s.user_id = auth.uid() AND s.status = 'active'
                 AND (s.expires_at IS NULL OR s.expires_at > now()))
  ));

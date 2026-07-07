import { createServerClient } from '@supabase/ssr'

// Creates a Supabase client scoped to the current request's user session.
// Use this (not the anon client) whenever you need to verify auth or read
// the profiles / deal_partners tables (which have RLS on them).
export function userClient(request) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: () => {} // read-only in route handlers; middleware refreshes tokens
      }
    }
  )
}

// Call at the top of every API route.
// Returns { user, isAllDeals, allowedDealIds } on success, or null if unauthenticated.
// isAllDeals=true means the org is a sponsor and can see all deals.
// allowedDealIds is an array of deal UUIDs for non-sponsor orgs.
export async function requireAuth(request) {
  const client = userClient(request)
  const { data: { user } } = await client.auth.getUser()
  if (!user) return null

  const { data: profile } = await client
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) {
    // No profile yet — bootstrap mode: treat as sponsor (all-deals access).
    // Run the Supabase setup SQL to link users to orgs before issuing partner logins.
    console.warn('[auth] No profile for user', user.id, '— granting full access (bootstrap mode)')
    return { user, isAllDeals: true, allowedDealIds: null }
  }

  const { data: org } = await client
    .from('organizations')
    .select('type')
    .eq('id', profile.org_id)
    .maybeSingle()

  if (org?.type === 'sponsor') {
    return { user, isAllDeals: true, allowedDealIds: null }
  }

  const { data: partners } = await client
    .from('deal_partners')
    .select('deal_id')
    .eq('org_id', profile.org_id)

  return {
    user,
    isAllDeals: false,
    allowedDealIds: (partners || []).map(p => p.deal_id)
  }
}

// Returns true if the auth result permits access to a specific deal.
export function canAccessDeal(auth, dealId) {
  if (auth.isAllDeals) return true
  return auth.allowedDealIds?.includes(dealId) ?? false
}

import { Resend } from 'resend'
import { requireAuth } from '@/lib/auth'

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth?.isAllDeals) return new Response('Forbidden', { status: 403 })

  const key = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'
  const to = auth.user.email

  if (!key) return Response.json({ error: 'RESEND_API_KEY not set' })
  if (!to) return Response.json({ error: 'No email on auth user' })

  try {
    const resend = new Resend(key)
    const result = await resend.emails.send({
      from,
      to,
      subject: 'Balboa email test',
      html: '<p>Email notifications are working.</p>',
    })
    return Response.json({ ok: true, from, to, result })
  } catch (err) {
    return Response.json({ ok: false, error: err.message })
  }
}

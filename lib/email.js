import { Resend } from 'resend'

// Notify all deal users that a new document was uploaded.
// Fire-and-forget — call without await so upload response isn't delayed.
export async function notifyDocumentUpload({ dealName, docName, category, uploaderEmail, recipientEmails }) {
  if (!process.env.RESEND_API_KEY) return
  const resend = new Resend(process.env.RESEND_API_KEY)
  const to = recipientEmails.filter(e => e && e !== uploaderEmail)
  if (!to.length) return

  const from = process.env.RESEND_FROM_EMAIL || 'Balboa Group <onboarding@resend.dev>'
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://balboa-test.vercel.app'

  await resend.emails.send({
    from,
    to,
    subject: `New document available: ${docName} — ${dealName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;color:#1f2937">
        <div style="background:#1e293b;padding:20px 28px;border-radius:8px 8px 0 0">
          <span style="color:#f8fafc;font-size:18px;font-weight:700">Balboa Group</span>
        </div>
        <div style="background:#f9fafb;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
          <p style="margin:0 0 16px 0;font-size:15px">A new document has been uploaded to <strong>${dealName}</strong>.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:8px 0;color:#6b7280;width:120px">Document</td>
              <td style="padding:8px 0;font-weight:600">${docName}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:8px 0;color:#6b7280">Category</td>
              <td style="padding:8px 0">${category}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#6b7280">Uploaded by</td>
              <td style="padding:8px 0">${uploaderEmail}</td>
            </tr>
          </table>
          <a href="${appUrl}" style="display:inline-block;background:#1e293b;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">View in Balboa Portfolio</a>
        </div>
      </div>
    `,
  })
}

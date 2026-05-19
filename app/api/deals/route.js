import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'

export async function GET() {
  const { data, error } = await supabase
    .from('deals')
    .select('id, name, market, address, unit_count, status')
    .order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

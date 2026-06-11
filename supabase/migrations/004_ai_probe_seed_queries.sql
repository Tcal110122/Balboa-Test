-- ============================================================
-- Migration 004 — Seed AI probe queries for all 8 properties
-- ============================================================

-- Helper: insert queries by property slug
-- Brand queries — property is named directly
-- Submarket queries — searcher doesn't know the property
-- Comparison queries — head-to-head or "best of" searches
-- Intent queries — relocation/lifestyle intent

-- ----------------------------------------------------------------
-- Irvington Place — Olivette, MO (Ladue school district)
-- ----------------------------------------------------------------
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Tell me about Irvington Place apartments in Olivette Missouri', 'brand' FROM properties WHERE slug = 'irvington-place';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Irvington Place Olivette reviews and pricing', 'brand' FROM properties WHERE slug = 'irvington-place';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'What are the best luxury apartments in Olivette MO?', 'submarket' FROM properties WHERE slug = 'irvington-place';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Apartments near Ladue school district in St Louis', 'submarket' FROM properties WHERE slug = 'irvington-place';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Upscale rentals in University City school district St Louis', 'submarket' FROM properties WHERE slug = 'irvington-place';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Compare luxury apartment options in Olivette and Clayton MO', 'comparison' FROM properties WHERE slug = 'irvington-place';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'I am relocating to St Louis and need a 2 bedroom near top-rated schools', 'intent' FROM properties WHERE slug = 'irvington-place';

-- ----------------------------------------------------------------
-- Darby at Briarcliff — Kansas City, MO
-- ----------------------------------------------------------------
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Tell me about Darby at Briarcliff apartments in Kansas City', 'brand' FROM properties WHERE slug = 'darby-at-briarcliff';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Darby at Briarcliff Kansas City reviews and floor plans', 'brand' FROM properties WHERE slug = 'darby-at-briarcliff';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'What are the best luxury apartments in Briarcliff Kansas City?', 'submarket' FROM properties WHERE slug = 'darby-at-briarcliff';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Upscale apartments north Kansas City MO with views', 'submarket' FROM properties WHERE slug = 'darby-at-briarcliff';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Best apartment communities in north Kansas City Missouri', 'submarket' FROM properties WHERE slug = 'darby-at-briarcliff';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'I am moving to Kansas City and want a luxury apartment with city views', 'intent' FROM properties WHERE slug = 'darby-at-briarcliff';

-- ----------------------------------------------------------------
-- 11th and Spruce — St. Louis, MO
-- ----------------------------------------------------------------
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Tell me about 11th and Spruce apartments in St Louis', 'brand' FROM properties WHERE slug = '11th-and-spruce';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, '11th and Spruce St Louis reviews and pricing', 'brand' FROM properties WHERE slug = '11th-and-spruce';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Best luxury apartments in downtown St Louis Missouri', 'submarket' FROM properties WHERE slug = '11th-and-spruce';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Luxury apartments in the heart of downtown St Louis', 'submarket' FROM properties WHERE slug = '11th-and-spruce';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'High-end apartments walking distance to the Arch St Louis', 'submarket' FROM properties WHERE slug = '11th-and-spruce';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'I am relocating to St Louis and want a walkable downtown apartment', 'intent' FROM properties WHERE slug = '11th-and-spruce';

-- ----------------------------------------------------------------
-- Pine25 — Charlotte, NC (North End)
-- ----------------------------------------------------------------
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Tell me about Pine25 apartments in Charlotte North Carolina', 'brand' FROM properties WHERE slug = 'pine25';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Pine25 North End Charlotte reviews and availability', 'brand' FROM properties WHERE slug = 'pine25';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Best new apartments in North End Charlotte NC', 'submarket' FROM properties WHERE slug = 'pine25';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Luxury apartments near NoDa and North End Charlotte', 'submarket' FROM properties WHERE slug = 'pine25';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'I am moving to Charlotte and want to live in an up-and-coming neighborhood', 'intent' FROM properties WHERE slug = 'pine25';

-- ----------------------------------------------------------------
-- The Henry — Charlotte, NC
-- ----------------------------------------------------------------
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Tell me about The Henry apartments in Charlotte NC', 'brand' FROM properties WHERE slug = 'the-henry';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'The Henry Charlotte reviews floor plans and pricing', 'brand' FROM properties WHERE slug = 'the-henry';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Best luxury apartment communities in Charlotte North Carolina', 'submarket' FROM properties WHERE slug = 'the-henry';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Upscale apartments in Charlotte with resort amenities', 'submarket' FROM properties WHERE slug = 'the-henry';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'I am relocating to Charlotte for work and need a high-end apartment', 'intent' FROM properties WHERE slug = 'the-henry';

-- ----------------------------------------------------------------
-- One at the Peninsula — Columbus, OH
-- ----------------------------------------------------------------
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Tell me about One at the Peninsula apartments in Columbus Ohio', 'brand' FROM properties WHERE slug = 'one-at-the-peninsula';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'One at the Peninsula Columbus OH reviews and pricing', 'brand' FROM properties WHERE slug = 'one-at-the-peninsula';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Best luxury apartments in downtown Columbus Ohio', 'submarket' FROM properties WHERE slug = 'one-at-the-peninsula';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'High-end apartments in the Peninsula neighborhood Columbus Ohio', 'submarket' FROM properties WHERE slug = 'one-at-the-peninsula';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Luxury apartments near Nationwide Arena downtown Columbus', 'submarket' FROM properties WHERE slug = 'one-at-the-peninsula';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'I am moving to Columbus Ohio and want a luxury downtown apartment', 'intent' FROM properties WHERE slug = 'one-at-the-peninsula';

-- ----------------------------------------------------------------
-- Ascend RVA — Richmond, VA
-- ----------------------------------------------------------------
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Tell me about Ascend RVA apartments in Richmond Virginia', 'brand' FROM properties WHERE slug = 'ascend-rva';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Ascend RVA Richmond reviews floor plans and pricing', 'brand' FROM properties WHERE slug = 'ascend-rva';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Best luxury apartments in Richmond Virginia', 'submarket' FROM properties WHERE slug = 'ascend-rva';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Student housing near VCU Richmond Virginia', 'submarket' FROM properties WHERE slug = 'ascend-rva';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Best apartments for VCU students in Richmond VA', 'submarket' FROM properties WHERE slug = 'ascend-rva';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'I am relocating to Richmond VA and want a high-end apartment near VCU', 'intent' FROM properties WHERE slug = 'ascend-rva';

-- ----------------------------------------------------------------
-- Bootes Bozeman — Bozeman, MT
-- ----------------------------------------------------------------
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Tell me about Bootes Bozeman apartments in Montana', 'brand' FROM properties WHERE slug = 'bootes-bozeman';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Bootes Bozeman MT reviews and availability', 'brand' FROM properties WHERE slug = 'bootes-bozeman';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Best luxury apartments in Bozeman Montana', 'submarket' FROM properties WHERE slug = 'bootes-bozeman';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Student housing near Montana State University Bozeman', 'submarket' FROM properties WHERE slug = 'bootes-bozeman';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'Best apartments for Montana State University students', 'submarket' FROM properties WHERE slug = 'bootes-bozeman';
INSERT INTO ai_probe_queries (property_id, query_text, category) SELECT id, 'I am moving to Bozeman Montana and need a nice apartment near MSU', 'intent' FROM properties WHERE slug = 'bootes-bozeman';

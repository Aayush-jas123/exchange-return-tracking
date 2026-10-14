-- ============================================================
-- Operators: Manufacture Portal Access Scope
-- Run in the Supabase SQL editor.
--
-- Adds a manufacture_scope column to the operators table.
-- Controls which tabs an operator sees in the Manufacture
-- Control Tower (/manufacture/admin):
--   'full'              = Dashboard, Samples, Production,
--                         Manufacturers, Tech Packs (default)
--   'samples_techpacks' = Samples, Tech Packs only
--
-- Super admin always sees all tabs regardless of this value.
-- ============================================================

alter table operators
  add column if not exists manufacture_scope text not null default 'full';

-- =============================================================================
-- Hilty ERP - Migration 0045: short-form memory for sales read from photos.
--
-- Handwritten receipts use short forms ("W-guard wo 4lt", "R-brush s/s").
-- When a user creates drafts from a photo, each item text is remembered with
-- the product it was matched to, so the next photo matches it straight away.
-- Written only by the server (service role); readable by company users.
-- =============================================================================

create table if not exists public.photo_item_aliases (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  alias       text not null check (length(alias) between 1 and 120),
  product_id  uuid not null references public.products(id) on delete cascade,
  uses        integer not null default 1 check (uses >= 0),
  created_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  unique (company_id, alias)
);
create index if not exists photo_item_aliases_product_idx on public.photo_item_aliases(product_id);

drop trigger if exists trg_photo_item_aliases_company on public.photo_item_aliases;
create trigger trg_photo_item_aliases_company before insert or update on public.photo_item_aliases
  for each row execute function public.check_company_consistency('product_id', 'products');

alter table public.photo_item_aliases enable row level security;
drop policy if exists photo_item_aliases_select on public.photo_item_aliases;
create policy photo_item_aliases_select on public.photo_item_aliases for select to authenticated
  using (public.has_company_access(company_id));
revoke all on public.photo_item_aliases from anon, authenticated;
grant select on public.photo_item_aliases to authenticated;
grant select, insert, update, delete on public.photo_item_aliases to service_role;

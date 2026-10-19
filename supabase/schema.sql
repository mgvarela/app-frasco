-- Frasco MVP schema. Run once in the Supabase SQL editor using a project owner account.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  whatsapp_number text check (
    whatsapp_number is null
    or whatsapp_number ~ '^[0-9]{8,15}$'
  ),
  contact_public boolean not null default false,
  role text not null default 'user' check (role in ('user', 'moderator', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 5 and 90),
  description text not null check (char_length(description) between 10 and 1200),
  category text not null check (category in ('jars', 'bottles', 'bulk', 'other')),
  price_ars integer not null check (price_ars between 0 and 100000000),
  price_unit text not null check (price_unit in ('unit', 'lot')),
  quantity integer not null check (quantity between 1 and 1000000),
  capacity_ml integer check (capacity_ml between 1 and 1000000),
  dimensions text check (dimensions is null or char_length(dimensions) <= 80),
  glass_condition text not null check (glass_condition in ('excellent', 'good', 'fair')),
  lid_condition text not null check (lid_condition in ('included', 'not_included', 'not_applicable', 'unknown')),
  location_label text not null check (char_length(location_label) between 2 and 80),
  status text not null default 'active' check (status in ('active', 'sold', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.listing_images (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  storage_path text not null unique check (char_length(storage_path) <= 300),
  position smallint not null default 0 check (position between 0 and 4),
  created_at timestamptz not null default now()
);

create table if not exists public.favorites (
  user_id uuid not null references public.profiles (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings (id) on delete set null,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null check (reason in ('misleading', 'prohibited', 'spam', 'safety', 'other')),
  details text check (details is null or char_length(details) <= 500),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  moderator_note text check (moderator_note is null or char_length(moderator_note) <= 500),
  created_at timestamptz not null default now(),
  unique (reporter_id, listing_id)
);

create index if not exists listings_active_created_idx
  on public.listings (created_at desc) where status = 'active';
create index if not exists listings_active_price_idx
  on public.listings (price_ars) where status = 'active';
create index if not exists listings_owner_status_idx
  on public.listings (owner_id, status, created_at desc);
create index if not exists listing_images_listing_position_idx
  on public.listing_images (listing_id, position);
create index if not exists reports_open_created_idx
  on public.reports (created_at) where status = 'open';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select role
    from public.profiles
    where id = auth.uid()
  ), 'user');
$$;

drop trigger if exists listings_set_updated_at on public.listings;
create trigger listings_set_updated_at
before update on public.listings
for each row execute function public.set_updated_at();

create or replace function public.limit_listing_images()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  image_count integer;
begin
  perform 1
  from public.listings
  where id = new.listing_id
  for update;

  select count(*) into image_count
  from public.listing_images
  where listing_id = new.listing_id;

  if image_count >= 5 then
    raise exception 'A listing can have at most five images';
  end if;

  new.position := image_count;
  return new;
end;
$$;

drop trigger if exists listing_images_limit on public.listing_images;
create trigger listing_images_limit
before insert on public.listing_images
for each row execute function public.limit_listing_images();

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_name text;
  profile_phone text;
begin
  profile_name := left(
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Usuario Frasco'
    ),
    60
  );
  profile_phone := nullif(
    regexp_replace(coalesce(new.raw_user_meta_data ->> 'whatsapp_number', ''), '[^0-9]', '', 'g'),
    ''
  );
  if profile_phone !~ '^[0-9]{8,15}$' then
    profile_phone := null;
  end if;

  insert into public.profiles (id, display_name, whatsapp_number)
  values (new.id, profile_name, profile_phone)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.create_profile_for_new_user();

insert into public.profiles (id, display_name, whatsapp_number)
select
  u.id,
  left(coalesce(
    nullif(trim(u.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
    'Usuario Frasco'
  ), 60),
  case
    when regexp_replace(coalesce(u.raw_user_meta_data ->> 'whatsapp_number', ''), '[^0-9]', '', 'g') ~ '^[0-9]{8,15}$'
      then regexp_replace(u.raw_user_meta_data ->> 'whatsapp_number', '[^0-9]', '', 'g')
    else null
  end
from auth.users as u
on conflict (id) do nothing;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('admin', 'moderator')
  );
$$;

create or replace function public.search_active_listings(
  p_query text default null,
  p_category text default null,
  p_price_min integer default null,
  p_price_max integer default null,
  p_quantity_min integer default null,
  p_location text default null,
  p_sort text default 'recent',
  p_page integer default 1,
  p_page_size integer default 12
)
returns table (
  id uuid,
  owner_id uuid,
  title text,
  description text,
  category text,
  price_ars integer,
  price_unit text,
  quantity integer,
  capacity_ml integer,
  dimensions text,
  glass_condition text,
  lid_condition text,
  location_label text,
  created_at timestamptz,
  owner_name text,
  owner_whatsapp text,
  image_paths text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    l.id,
    l.owner_id,
    l.title,
    l.description,
    l.category,
    l.price_ars,
    l.price_unit,
    l.quantity,
    l.capacity_ml,
    l.dimensions,
    l.glass_condition,
    l.lid_condition,
    l.location_label,
    l.created_at,
    case when p.contact_public then p.display_name else 'Usuario Frasco' end,
    case when p.contact_public then p.whatsapp_number else null end,
    coalesce(images.paths, array[]::text[])
  from public.listings as l
  left join public.profiles as p on p.id = l.owner_id
  left join lateral (
    select array_agg(i.storage_path order by i.position, i.created_at) as paths
    from public.listing_images as i
    where i.listing_id = l.id
  ) as images on true
  where l.status = 'active'
    and (p_query is null or strpos(lower(l.title || ' ' || l.description), lower(trim(p_query))) > 0)
    and (p_category is null or l.category = p_category)
    and (p_price_min is null or l.price_ars >= p_price_min)
    and (p_price_max is null or l.price_ars <= p_price_max)
    and (p_quantity_min is null or l.quantity >= p_quantity_min)
    and (p_location is null or strpos(lower(l.location_label), lower(trim(p_location))) > 0)
    and p_sort in ('recent', 'price_asc', 'price_desc')
  order by
    case when p_sort = 'price_asc' then l.price_ars end asc nulls last,
    case when p_sort = 'price_desc' then l.price_ars end desc nulls last,
    case when p_sort = 'recent' then l.created_at end desc nulls last,
    l.id desc
  limit least(greatest(coalesce(p_page_size, 12), 1), 50)
  offset (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 12), 1), 50);
$$;

alter table public.profiles enable row level security;
alter table public.listings enable row level security;
alter table public.listing_images enable row level security;
alter table public.favorites enable row level security;
alter table public.reports enable row level security;

drop policy if exists "Profiles are visible to their owner, opted-in visitors, and moderators" on public.profiles;
create policy "Profiles are visible to their owner, opted-in visitors, and moderators"
on public.profiles for select to anon, authenticated
using (id = (select auth.uid()) or contact_public or (select public.is_admin()));

drop policy if exists "Users update only their own profile" on public.profiles;
create policy "Users update only their own profile"
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

revoke all on public.profiles from anon, authenticated;
grant select (id, display_name, whatsapp_number, contact_public) on public.profiles to anon, authenticated;
grant update (display_name, whatsapp_number, contact_public) on public.profiles to authenticated;

drop policy if exists "Public can read active listings; owners and moderators can read all" on public.listings;
create policy "Public can read active listings; owners and moderators can read all"
on public.listings for select to anon, authenticated
using (status = 'active' or owner_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "Users create listings as themselves" on public.listings;
create policy "Users create listings as themselves"
on public.listings for insert to authenticated
with check (owner_id = (select auth.uid()));

drop policy if exists "Owners and moderators update listings" on public.listings;
create policy "Owners and moderators update listings"
on public.listings for update to authenticated
using (owner_id = (select auth.uid()) or (select public.is_admin()))
with check (owner_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "Owners and moderators delete listings" on public.listings;
create policy "Owners and moderators delete listings"
on public.listings for delete to authenticated
using (owner_id = (select auth.uid()) or (select public.is_admin()));

revoke all on public.listings from anon, authenticated;
grant select on public.listings to anon, authenticated;
grant insert (owner_id, title, description, category, price_ars, price_unit, quantity, capacity_ml, dimensions, glass_condition, lid_condition, location_label, status)
  on public.listings to authenticated;
grant update (title, description, category, price_ars, price_unit, quantity, capacity_ml, dimensions, glass_condition, lid_condition, location_label, status)
  on public.listings to authenticated;
grant delete on public.listings to authenticated;

drop policy if exists "Listing photos follow listing visibility" on public.listing_images;
create policy "Listing photos follow listing visibility"
on public.listing_images for select to anon, authenticated
using (exists (
  select 1 from public.listings as l
  where l.id = listing_id
    and (l.status = 'active' or l.owner_id = (select auth.uid()) or (select public.is_admin()))
));

drop policy if exists "Owners add photos to their listings" on public.listing_images;
create policy "Owners add photos to their listings"
on public.listing_images for insert to authenticated
with check (exists (
  select 1 from public.listings as l
  where l.id = listing_id and l.owner_id = (select auth.uid())
));

drop policy if exists "Owners and moderators remove listing photos" on public.listing_images;
create policy "Owners and moderators remove listing photos"
on public.listing_images for delete to authenticated
using (exists (
  select 1 from public.listings as l
  where l.id = listing_id and (l.owner_id = (select auth.uid()) or (select public.is_admin()))
));

revoke all on public.listing_images from anon, authenticated;
grant select on public.listing_images to anon, authenticated;
grant insert (listing_id, storage_path, position) on public.listing_images to authenticated;
grant delete on public.listing_images to authenticated;

drop policy if exists "Users manage their own favorites" on public.favorites;
create policy "Users manage their own favorites"
on public.favorites for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

revoke all on public.favorites from anon, authenticated;
grant select, insert, delete on public.favorites to authenticated;

drop policy if exists "Reporters and moderators can read reports" on public.reports;
create policy "Reporters and moderators can read reports"
on public.reports for select to authenticated
using (reporter_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "Users can report another user's active listing" on public.reports;
create policy "Users can report another user's active listing"
on public.reports for insert to authenticated
with check (
  reporter_id = (select auth.uid())
  and exists (
    select 1 from public.listings as l
    where l.id = listing_id
      and l.status = 'active'
      and l.owner_id <> (select auth.uid())
  )
);

drop policy if exists "Moderators update report decisions" on public.reports;
create policy "Moderators update report decisions"
on public.reports for update to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

revoke all on public.reports from anon, authenticated;
grant select, insert on public.reports to authenticated;
grant update (status, moderator_note) on public.reports to authenticated;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.search_active_listings(text, text, integer, integer, integer, text, text, integer, integer)
  to anon, authenticated;

-- Images are private; signed URLs are issued only when Storage RLS allows access.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-images', 'listing-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Visible listing images can be read" on storage.objects;
create policy "Visible listing images can be read"
on storage.objects for select to anon, authenticated
using (
  bucket_id = 'listing-images'
  and exists (
    select 1
    from public.listings as l
    where l.id::text = (storage.foldername(name))[2]
      and l.owner_id::text = (storage.foldername(name))[1]
      and (
        l.status = 'active'
        or l.owner_id = (select auth.uid())
        or (select public.is_admin())
      )
  )
);

drop policy if exists "Listing owners upload their own images" on storage.objects;
create policy "Listing owners upload their own images"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'listing-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.listings as l
    where l.id::text = (storage.foldername(name))[2]
      and l.owner_id = (select auth.uid())
  )
);

drop policy if exists "Listing owners delete their own images" on storage.objects;
create policy "Listing owners delete their own images"
on storage.objects for delete to authenticated
using (
  bucket_id = 'listing-images'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or (select public.is_admin())
  )
);

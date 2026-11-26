-- 오늘한컷 Supabase 설정
-- Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run 을 누르세요.
-- 맨 아래 "가족 코드" 한 줄만 바꾸면 됩니다. (SQL Editor 에 붙여넣은 뒤에만 바꾸고, 저장소의 이 파일에는 진짜 코드를 적지 마세요)

create extension if not exists pgcrypto with schema extensions;

-- 가족 코드 (해시로만 저장, 아무도 읽을 수 없음)
create table if not exists public.family (
  id int primary key default 1 check (id = 1),
  join_code_hash text not null
);

-- 가족 4명 자리. id 는 영문(사진 저장 경로용), nickname 은 화면에 보이는 이름
create table if not exists public.members (
  id text primary key,
  nickname text not null unique,
  is_painter boolean not null default false,
  auth_uid uuid unique,
  joined_at timestamptz
);
insert into public.members (id, nickname, is_painter) values
  ('jjangtori', '짱토리', true),
  ('ssu', '쑤', false),
  ('inijjang', '이니짱', false),
  ('torioppa', '토리오빠', false)
on conflict (id) do nothing;

create table if not exists public.photos (
  day date not null,
  member_id text not null references public.members(id),
  path text not null,
  caption text not null default '' check (char_length(caption) <= 40),
  created_at timestamptz not null default now(),
  primary key (day, member_id)
);

create table if not exists public.votes (
  day date not null,
  voter text not null references public.members(id),
  target text not null references public.members(id),
  updated_at timestamptz not null default now(),
  primary key (day, voter),
  check (voter <> target)
);

create table if not exists public.paintings (
  week_start date primary key,
  path text not null,
  created_at timestamptz not null default now()
);

-- 도우미 함수 (한국 시간 기준)
create or replace function public.kst_now() returns timestamp
language sql stable as $$ select now() at time zone 'Asia/Seoul' $$;

create or replace function public.kst_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Seoul')::date $$;

create or replace function public.my_member_id() returns text
language sql stable security definer set search_path = public as $$
  select id from public.members where auth_uid = auth.uid()
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where auth_uid = auth.uid())
$$;

create or replace function public.is_painter() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where auth_uid = auth.uid() and is_painter)
$$;

-- d 날짜 사진의 투표는 다음 날 0시부터 낮 12시까지
create or replace function public.vote_open(d date) returns boolean
language sql stable as $$
  select public.kst_now() >= (d + 1)::timestamp
     and public.kst_now() <  (d + 1)::timestamp + interval '12 hours'
$$;

create or replace function public.has_photo(d date, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.photos where day = d and member_id = m)
$$;

-- 초대 링크의 가족 코드로 이름 자리에 들어가기 (폰을 바꿨을 때 다시 들어가기도 같은 방법)
create or replace function public.join_family(p_code text, p_member text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select join_code_hash = extensions.crypt(p_code, join_code_hash) into ok from public.family where id = 1;
  if not coalesce(ok, false) then raise exception 'bad_code'; end if;
  if not exists (select 1 from public.members where id = p_member) then raise exception 'bad_member'; end if;
  update public.members set auth_uid = null where auth_uid = auth.uid() and id <> p_member;
  update public.members set auth_uid = auth.uid(), joined_at = now() where id = p_member;
  return p_member;
end $$;

revoke all on function public.join_family(text, text) from public, anon;
grant execute on function public.join_family(text, text) to authenticated;

-- 보안 규칙: 가족만 보고, 각자 자기 것만 쓴다
alter table public.family enable row level security;
alter table public.members enable row level security;
alter table public.photos enable row level security;
alter table public.votes enable row level security;
alter table public.paintings enable row level security;

drop policy if exists "members read" on public.members;
create policy "members read" on public.members for select to authenticated using (public.is_member());

drop policy if exists "photos read" on public.photos;
create policy "photos read" on public.photos for select to authenticated using (public.is_member());
drop policy if exists "photos insert own today" on public.photos;
create policy "photos insert own today" on public.photos for insert to authenticated
  with check (member_id = public.my_member_id() and day = public.kst_today());
drop policy if exists "photos update own today" on public.photos;
create policy "photos update own today" on public.photos for update to authenticated
  using (member_id = public.my_member_id() and day = public.kst_today())
  with check (member_id = public.my_member_id() and day = public.kst_today());

drop policy if exists "votes read" on public.votes;
create policy "votes read" on public.votes for select to authenticated using (public.is_member());
drop policy if exists "votes insert own" on public.votes;
create policy "votes insert own" on public.votes for insert to authenticated
  with check (voter = public.my_member_id() and target <> voter and public.vote_open(day) and public.has_photo(day, target));
drop policy if exists "votes update own" on public.votes;
create policy "votes update own" on public.votes for update to authenticated
  using (voter = public.my_member_id() and public.vote_open(day))
  with check (voter = public.my_member_id() and target <> voter and public.vote_open(day) and public.has_photo(day, target));

drop policy if exists "paintings read" on public.paintings;
create policy "paintings read" on public.paintings for select to authenticated using (public.is_member());
drop policy if exists "paintings write" on public.paintings;
create policy "paintings write" on public.paintings for insert to authenticated with check (public.is_painter());
drop policy if exists "paintings update" on public.paintings;
create policy "paintings update" on public.paintings for update to authenticated using (public.is_painter()) with check (public.is_painter());

-- 사진 저장소 (비공개). 경로: photos/<내 id>/... , paintings/...
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('family', 'family', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "family files read" on storage.objects;
create policy "family files read" on storage.objects for select to authenticated
  using (bucket_id = 'family' and public.is_member());

drop policy if exists "family files upload" on storage.objects;
create policy "family files upload" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'family' and public.is_member() and (
      ((storage.foldername(name))[1] = 'photos' and (storage.foldername(name))[2] = public.my_member_id())
      or ((storage.foldername(name))[1] = 'paintings' and public.is_painter())
    )
  );

drop policy if exists "family files delete own" on storage.objects;
create policy "family files delete own" on storage.objects for delete to authenticated
  using (
    bucket_id = 'family' and public.is_member() and (
      ((storage.foldername(name))[1] = 'photos' and (storage.foldername(name))[2] = public.my_member_id())
      or ((storage.foldername(name))[1] = 'paintings' and public.is_painter())
    )
  );

-- 앱(Data API)이 표와 함수에 접근하도록 허락 (2026-05-30 이후 새 프로젝트는 자동으로 열리지 않음)

grant usage on schema public to anon, authenticated;

grant select on public.members to authenticated;
grant select, insert, update on public.photos to authenticated;
grant select, insert, update on public.votes to authenticated;
grant select, insert, update on public.paintings to authenticated;
-- family 표(가족 코드)는 일부러 허락하지 않습니다.

grant execute on function public.kst_now() to authenticated;
grant execute on function public.kst_today() to authenticated;
grant execute on function public.my_member_id() to authenticated;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_painter() to authenticated;
grant execute on function public.vote_open(date) to authenticated;
grant execute on function public.has_photo(date, text) to authenticated;
grant execute on function public.join_family(text, text) to authenticated;

-- ▼▼▼ 가족 코드: 'CHANGE-ME-family-code' 를 영문·숫자로 된 10자 이상 아무도 모를 말로 바꾸세요 ▼▼▼
--      (예: tori-k7m2-spring). 이 코드가 초대 링크에 들어가니 가족 외에는 알려주지 마세요.
insert into public.family (id, join_code_hash)
values (1, extensions.crypt('CHANGE-ME-family-code', extensions.gen_salt('bf')))
on conflict (id) do update set join_code_hash = excluded.join_code_hash;

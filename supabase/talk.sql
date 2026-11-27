-- 오늘한컷 · 오늘톡 설정 (하루 한 명이 질문, 나머지가 한 줄로 답하기)
-- Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run 을 누르세요.
-- schema.sql 을 먼저 실행한 프로젝트에서만 동작합니다. 여러 번 실행해도 괜찮습니다.

create table if not exists public.talk_questions (
  day date primary key,
  asker text not null references public.members(id),
  question text not null check (char_length(question) between 1 and 80),
  created_at timestamptz not null default now()
);

create table if not exists public.talk_answers (
  day date not null references public.talk_questions(day) on delete cascade,
  member_id text not null references public.members(id),
  answer text not null check (char_length(answer) between 1 and 100),
  updated_at timestamptz not null default now(),
  primary key (day, member_id)
);

-- 질문 담당 순서: 짱토리 → 쑤 → 이니짱 → 토리오빠 (2026-11-27 이 짱토리 차례)
create or replace function public.talk_asker(d date) returns text
language sql immutable as $$
  select (array['jjangtori','ssu','inijjang','torioppa'])[(((d - date '2026-11-27') % 4) + 4) % 4 + 1]
$$;

create or replace function public.has_talk_answer(d date, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.talk_answers where day = d and member_id = m)
$$;

-- 아직 볼 수 없는 답의 개수 (잠금 화면에 "답 2개가 기다려요" 표시용)
create or replace function public.talk_answer_count(d date) returns int
language sql stable security definer set search_path = public as $$
  select case when public.is_member() then (select count(*)::int from public.talk_answers where day = d) else 0 end
$$;

alter table public.talk_questions enable row level security;
alter table public.talk_answers enable row level security;

drop policy if exists "talk q read" on public.talk_questions;
create policy "talk q read" on public.talk_questions for select to authenticated using (public.is_member());

-- 질문은 오늘 담당만. 낮 12시가 지나도 질문이 없으면 누구나 올릴 수 있음
drop policy if exists "talk q insert" on public.talk_questions;
create policy "talk q insert" on public.talk_questions for insert to authenticated
  with check (day = public.kst_today() and asker = public.my_member_id()
    and (asker = public.talk_asker(day) or extract(hour from public.kst_now()) >= 12));
drop policy if exists "talk q update" on public.talk_questions;
create policy "talk q update" on public.talk_questions for update to authenticated
  using (day = public.kst_today() and asker = public.my_member_id())
  with check (day = public.kst_today() and asker = public.my_member_id());

-- 답은 "내가 답했거나, 내가 질문했거나, 지난 날" 일 때만 보임
drop policy if exists "talk a read" on public.talk_answers;
create policy "talk a read" on public.talk_answers for select to authenticated
  using (public.is_member() and (
    member_id = public.my_member_id()
    or day < public.kst_today()
    or exists (select 1 from public.talk_questions q where q.day = talk_answers.day and q.asker = public.my_member_id())
    or public.has_talk_answer(day, public.my_member_id())
  ));
drop policy if exists "talk a insert" on public.talk_answers;
create policy "talk a insert" on public.talk_answers for insert to authenticated
  with check (member_id = public.my_member_id() and day = public.kst_today());
drop policy if exists "talk a update" on public.talk_answers;
create policy "talk a update" on public.talk_answers for update to authenticated
  using (member_id = public.my_member_id() and day = public.kst_today())
  with check (member_id = public.my_member_id() and day = public.kst_today());

grant select, insert, update on public.talk_questions to authenticated;
grant select, insert, update on public.talk_answers to authenticated;
grant execute on function public.talk_asker(date) to authenticated;
grant execute on function public.has_talk_answer(date, text) to authenticated;
grant execute on function public.talk_answer_count(date) to authenticated;

notify pgrst, 'reload schema';

-- 오늘한컷: 앱이 표와 함수에 접근할 수 있게 허락하기
-- 2026년 5월 30일 이후 만든 Supabase 프로젝트는 새 표를 앱(Data API)에 자동으로 열어주지 않습니다.
-- SQL Editor 에 이 파일 전체를 붙여넣고 Run 하세요. 여러 번 실행해도 괜찮고, 지우는 것은 없습니다.
-- (누가 무엇을 읽고 쓸 수 있는지는 schema.sql 의 보안 규칙(RLS)이 그대로 정합니다)

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

-- 앱이 바뀐 권한을 바로 알도록 새로 고침
notify pgrst, 'reload schema';

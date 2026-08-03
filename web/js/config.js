// Supabase 접속 정보입니다.
//
// 이 키를 공개 저장소에 넣어도 되는 이유:
// sb_publishable_로 시작하는 "공개용 키"라서, 이름 그대로 브라우저에 노출되는 것을 전제로
// 만들어진 키입니다. 이 키만으로는 아무 데이터도 못 봅니다. 실제 보호는 DB에 걸어둔
// RLS(행 단위 보안) 정책이 하고, 지금 정책은 전부 "로그인한 사람만" 조건입니다.
//
// 반대로 sb_secret_ 으로 시작하는 키는 RLS를 통째로 무시하므로 절대 여기 넣으면 안 됩니다.
export const SUPABASE_URL = "https://qapyzbcjrzditfvpccoj.supabase.co";
export const SUPABASE_KEY = "sb_publishable_TVES_-X9P9HtWLgMrqsP5Q_82aKnibE";

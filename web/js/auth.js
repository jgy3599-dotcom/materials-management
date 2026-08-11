// 로그인 관련 기능을 모아둔 파일입니다.
import { supabase } from "./supabase.js";

// 감사 로그는 관리자보다 더 높은 권한으로, 이 계정에서만 볼 수 있게 제한합니다.
// (실제 차단은 Supabase의 RLS 정책이 하고, 이건 화면에 아예 안 보이게 하는 용도입니다.)
export const SUPER_ADMIN_EMAIL = "gyjeong@hanjin.com";


// 로그인 후 이 시간이 지나면 자동으로 로그아웃시킵니다.
// Supabase의 "Time-box user sessions"(로그인 후 일정 시간이 지나면 강제 로그아웃)는
// 유료(Pro) 플랜 기능이라 무료 플랜에서는 켤 수 없습니다. 그래서 서버가 아니라
// 이 앱 코드에서 직접 흉내냅니다 — 브라우저 안에서 도는 검사라 서버가 강제하는
// 것만큼 완벽하진 않지만, 실사용에서는 차이가 없습니다.
// 시간을 조절하고 싶으면 이 숫자만 바꾸면 됩니다.
const MAX_SESSION_HOURS = 1;
const LOGIN_TIME_KEY = "login_at";


// 지금 로그인된 세션을 돌려줍니다. 로그인 안 했으면 null입니다.
// 브라우저에 저장돼 있어서 새로고침하거나 창을 닫았다 열어도 유지됩니다.
export async function getSession() {
    const { data } = await supabase.auth.getSession();
    return data.session;
}


// 권한을 읽습니다. 계정에 권한이 안 적혀 있으면 '일반'으로 봅니다.
//
// ⚠️ user_metadata가 아니라 app_metadata입니다. user_metadata는 로그인한 본인이
// 브라우저에서 직접 고칠 수 있어서, 거기에 권한을 두면 일반 계정이 스스로 관리자가
// 됩니다. app_metadata는 service_role 키로만 쓸 수 있습니다(manage_users.py).
// DB의 권한 정책들도 같은 칸을 봅니다. 한쪽만 바꾸면 화면과 DB가 어긋납니다.
export function getRole(session) {
    return session?.user?.app_metadata?.role ?? "일반";
}


export function isAdmin(session) {
    return getRole(session) === "관리자";
}


export function isSuperAdmin(session) {
    return session?.user?.email === SUPER_ADMIN_EMAIL;
}


// 로그인합니다. 실패하면 사람이 읽을 수 있는 문구로 바꿔서 오류를 냅니다.
export async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
        // Supabase가 주는 영어 메시지를 그대로 보여주면 무슨 말인지 알기 어려워서 바꿉니다.
        const message = /invalid login credentials/i.test(error.message)
            ? "이메일 또는 비밀번호가 올바르지 않습니다."
            : `로그인에 실패했습니다. (${error.message})`;
        throw new Error(message);
    }
    // 최대 로그인 유지시간을 재는 기준 시각을 남깁니다.
    localStorage.setItem(LOGIN_TIME_KEY, String(Date.now()));
    return data.session;
}


export async function signOut() {
    // 네트워크가 끊긴 상태에서는 여기서 오류를 던지지 않고 { error }만 돌려줍니다.
    // 그때는 실제로 로그아웃되지 않은 것이므로, 기준 시각을 지우면 안 됩니다.
    // 지워버리면 다음 확인 때 "기준 시각 없음"으로 보여 최대 유지시간 검사가
    // 그 뒤로 계속 꺼진 채로 남습니다.
    const { error } = await supabase.auth.signOut();
    if (!error) localStorage.removeItem(LOGIN_TIME_KEY);
}


// 로그인 후 MAX_SESSION_HOURS가 지났으면 로그아웃시킵니다. main.js가 주기적으로 부릅니다.
//
// 기준 시각이 없으면(이 기능이 생기기 전에 이미 로그인해 있던 세션) 아무 것도 하지
// 않습니다 — 없는 걸 "만료됨"으로 보면 배포 순간 모든 사람이 갑자기 로그아웃됩니다.
// 다음 로그인부터는 정상적으로 시간이 재집니다.
export async function enforceMaxSession() {
    const loginAt = Number(localStorage.getItem(LOGIN_TIME_KEY));
    if (!loginAt) return;
    if (Date.now() - loginAt > MAX_SESSION_HOURS * 60 * 60 * 1000) {
        await signOut();
    }
}


// 로그인/로그아웃이 일어날 때마다 알려줍니다. 다른 탭에서 로그아웃해도 여기로 들어옵니다.
export function onAuthChange(callback) {
    supabase.auth.onAuthStateChange((_event, session) => callback(session));
}

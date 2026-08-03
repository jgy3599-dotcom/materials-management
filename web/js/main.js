// 배포가 제대로 됐는지 단계별로 확인해서 화면에 보여줍니다.
// 앞으로 화면을 붙여나가기 전에, 밑바탕이 정상인지부터 확인하려고 만든 페이지입니다.
import { supabase, checkConnection } from "./supabase.js";
import { SUPABASE_URL } from "./config.js";

// 점검 항목 한 줄의 표시를 바꿉니다. state는 ok / warn / error 중 하나입니다.
function setCheck(id, state, detail) {
    const row = document.getElementById(id);
    const mark = { ok: "✅", warn: "⏳", error: "❌" }[state];
    row.querySelector(".mark").textContent = mark;
    row.querySelector(".mark").className = "mark " + state;
    row.querySelector(".detail").textContent = detail;
}

async function run() {
    // 1) 이 스크립트가 실행됐다는 것 자체가 정적 호스팅이 동작한다는 뜻입니다.
    setCheck("c-page", "ok", "정적 호스팅 정상");

    // 2) 설정 파일이 제대로 불러와졌는지
    if (SUPABASE_URL && SUPABASE_URL.startsWith("https://")) {
        setCheck("c-config", "ok", SUPABASE_URL);
    } else {
        setCheck("c-config", "error", "config.js의 주소가 비어있습니다");
        return;
    }

    // 3) Supabase 라이브러리가 CDN에서 불러와졌는지
    if (supabase && supabase.auth) {
        setCheck("c-lib", "ok", "supabase-js 불러오기 완료");
    } else {
        setCheck("c-lib", "error", "CDN에서 라이브러리를 못 불러왔습니다");
        return;
    }

    // 4) 실제로 Supabase 서버까지 닿는지
    try {
        await checkConnection();
        setCheck("c-conn", "ok", "서버 응답 정상");
    } catch (e) {
        setCheck("c-conn", "error", String(e.message || e));
        return;
    }

    // 5) 지금 로그인된 상태인지 (아직 로그인 화면이 없어서 보통 "없음"이 정상입니다)
    const { data } = await supabase.auth.getSession();
    if (data.session) {
        setCheck("c-session", "ok", `로그인됨: ${data.session.user.email}`);
    } else {
        setCheck("c-session", "warn", "아직 로그인 안 함 (다음 단계에서 만듭니다)");
    }

    document.getElementById("result").textContent =
        "밑바탕 확인 완료. 다음 단계는 로그인 화면입니다.";
}

run();

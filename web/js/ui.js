// 화면들이 공통으로 쓰는 작은 도구들입니다.

// DB 작업이 실패했을 때 사람이 읽을 수 있는 문구로 바꿉니다.
// Streamlit 앱의 run_db()에 해당합니다. 개발자용 오류 내용을 그대로 보여주면
// 무슨 일이 일어난 건지 알기 어려워서, 안내 문구 뒤에 원문을 괄호로 덧붙입니다.
export function describeError(err, whatFailed) {
    const detail = err?.message ?? String(err);
    return `${whatFailed}\n\n(${detail})`;
}


// 화면 위쪽 안내줄에 메시지를 띄웁니다. 빈 문자열을 주면 감춥니다.
//
// warn은 "일은 됐지만 봐둘 것이 있다"는 뜻입니다. 실패(error)와 같은 빨간 상자를 쓰면
// 성공한 등록을 실패로 오해해서 한 번 더 누르게 되므로 따로 둡니다.
export function setStatus(elementId, message, kind = "info") {
    const box = document.getElementById(elementId);
    if (!box) return;
    box.textContent = message;
    box.className = { info: "caption", error: "error-msg", ok: "ok-msg", warn: "warn-msg" }[kind];
    box.classList.toggle("hidden", !message);
}


// DB에서 온 값을 화면에 넣기 전에 특수문자를 무해하게 바꿉니다.
// 비고 같은 자유 입력칸에 <, > 가 들어 있어도 화면이 깨지지 않게 하려는 것입니다.
export function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}


export function hasValue(v) {
    return v !== null && v !== undefined && String(v).trim() !== "";
}


// 오늘 날짜를 date 입력칸에 넣을 수 있는 형태(YYYY-MM-DD)로 돌려줍니다.
// 브라우저가 있는 곳의 날짜 기준입니다.
export function today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


// 선택칸을 다시 그리면 골라둔 값이 첫 번째 것으로 되돌아갑니다. 폼을 채우던 중에
// 새로고침을 누르면 글로 쓴 칸은 남고 선택칸만 바뀌어서, 폼이 멀쩡해 보이는 채로
// 엉뚱한 자재로 등록될 수 있습니다. 그래서 다시 그리기 전에 고른 값을 기억했다가
// 그 값이 아직 목록에 있으면 되돌려 놓습니다.
//
// 출고 화면과 구매요청 화면이 같이 씁니다. 화면마다 따로 베껴 두면 한쪽만 고쳐져
// 갈라집니다(실제로 그래서 구매요청 화면에만 이 처리가 빠져 있었습니다).
export function refill(select, html) {
    const keep = select.value;
    select.innerHTML = html;
    if (keep && [...select.options].some((o) => o.value === keep)) select.value = keep;
}

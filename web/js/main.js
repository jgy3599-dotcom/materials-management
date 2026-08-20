// 화면 전환(로그인 ↔ 앱, 메뉴 간 이동)을 담당합니다.
import { getSession, getRole, isAdmin, isSuperAdmin, signIn, signOut, onAuthChange, enforceMaxSession } from "./auth.js";
import { getDashboardSummary } from "./db.js";
import { redrawTable } from "./table.js";
import { onDataChanged } from "./refresh.js";
import * as boqPage from "./pages/boq.js";
import * as materialsPage from "./pages/materials.js";
import * as usagePage from "./pages/usage.js";
import * as purchasePage from "./pages/purchase.js";
import * as repairsPage from "./pages/repairs.js";
import * as registerPage from "./pages/register.js";
import * as alertPage from "./pages/alert.js";

const loadingView = document.getElementById("loading-view");
const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");

// 메뉴 이름과, 그 메뉴를 열 때 할 일을 짝지어 둡니다.
// tableId를 적어두면, 그 화면으로 돌아올 때 표를 다시 그려줍니다.
// 숨어 있는 동안에는 표의 크기가 0이라 그냥 두면 행이 안 보입니다.
const PAGES = {
    boq: { load: null, tableId: null },
    materials: { load: () => materialsPage.load(), tableId: "materials-table" },
    usage: { load: () => usagePage.load(), tableId: "usage-table" },
    purchase: { load: () => purchasePage.load(), tableId: "purchase-requests-table" },
    repairs: { load: () => repairsPage.load(), tableId: "repairs-table" },
    register: { load: () => registerPage.load(), tableId: null },
    alert: { load: () => alertPage.load(), tableId: "alert-table" },
};

let currentPage = "boq";

// 재고나 자재가 바뀌면 모든 화면의 "이미 읽었음" 표시를 지웁니다. 그 화면을 다음에 열 때
// goToPage가 load()를 부르면서 새로 읽어옵니다. 여기서 바로 읽지는 않습니다 — 볼 일도
// 없는 화면까지 매번 불러오면 통신만 늘어납니다.
//
// 신호를 보낸 화면 자신도 함께 꺼지지만, 그 화면은 곧이어 스스로 load(true)로 다시 읽어
// 표시를 도로 켭니다. 그래서 "누가 보냈는지"를 따질 필요가 없습니다.
//
// BOQ 화면은 검색할 때마다 새로 받아오므로 들고 있는 내용이 없습니다.
const REFRESHABLE = [materialsPage, usagePage, purchasePage, repairsPage, registerPage, alertPage];


function show(view) {
    for (const v of [loadingView, loginView, appView]) {
        v.classList.toggle("hidden", v !== view);
    }
}


function showError(message) {
    loginError.textContent = message;
    loginError.classList.remove("hidden");
}


function clearError() {
    loginError.textContent = "";
    loginError.classList.add("hidden");
}


// 메뉴를 바꿉니다. 그 화면에 처음 들어갈 때만 데이터를 불러옵니다.
function goToPage(name) {
    currentPage = name;

    for (const key of Object.keys(PAGES)) {
        document.getElementById(`page-${key}`).classList.toggle("hidden", key !== name);
    }
    for (const btn of document.querySelectorAll(".nav-btn")) {
        btn.classList.toggle("active", btn.dataset.page === name);
    }

    PAGES[name].load?.();
    if (PAGES[name].tableId) redrawTable(PAGES[name].tableId);

    // 맨 위 요약도 같이 다시 셉니다. 로그인할 때 한 번만 세면, 출고로 재고가 표준재고
    // 아래로 떨어져도 "표준재고 부족" 카드가 하루 종일 안 나타납니다. 문제가 생겼을 때
    // 눈에 띄게 하려고 만든 카드인데 정작 그때 안 뜨는 셈입니다.
    // 숫자만 세어 오는 가벼운 호출이라 메뉴를 옮길 때마다 불러도 부담이 없습니다.
    loadSummary();
}


// 맨 위 요약을 채웁니다. 자재 목록 전체를 받지 않고 숫자만 세어 옵니다.
// 부족한 자재가 없으면 그 카드를 아예 감춥니다. 문제가 없을 때도 "0건"을 띄워두면
// 정작 문제가 생겼을 때의 신호가 묻힙니다.
async function loadSummary() {
    try {
        const s = await getDashboardSummary();
        setMetric("m-total", s.total);
        setMetric("m-need", s.needPurchase);
        document.getElementById("m-need-card")
            .classList.toggle("hidden", s.needPurchase === 0);
    } catch {
        // 요약은 부가 정보라, 못 가져와도 화면 전체를 막지는 않습니다.
        document.getElementById("m-total").textContent = "-";
        document.getElementById("m-need-card").classList.add("hidden");
    }
}


// 단위는 숫자보다 작고 흐리게 붙습니다. 수량이 먼저 읽히게 하려는 것입니다.
function setMetric(id, value) {
    document.getElementById(id).innerHTML =
        `${Number(value).toLocaleString()}<span class="unit">건</span>`;
}


function render(session) {
    if (session) {
        document.getElementById("user-email").textContent = session.user.email;
        document.getElementById("user-role").textContent = getRole(session);
        materialsPage.setUser(session, isAdmin(session), isSuperAdmin(session));
        purchasePage.setUser(session, isAdmin(session));
        registerPage.setUser(session, isAdmin(session));
        usagePage.setUser(session, isAdmin(session));
        repairsPage.setUser(session);
        alertPage.setUser(session);
        show(appView);
        goToPage(currentPage);   // 요약은 goToPage가 함께 갱신합니다
    } else {
        // ⚠️ 비우는 도중에 오류가 나도 로그인 화면 전환은 반드시 해야 합니다. 예전에는
        // show(loginView)가 맨 아래에 있어서, 아래 setUser 중 하나가 DOM 오류를 내면
        // 거기서 멈춰 "로그아웃했는데 앱 화면이 그대로 남는" 상태가 됐습니다.
        // 비우기를 먼저 시도하는 순서는 그대로 두고, 전환만 finally로 뺐습니다.
        try {
            // 팝업은 화면 맨 위층에 뜨기 때문에 로그인 화면으로 돌아가도 그대로 남습니다.
            // 다른 탭에서 로그아웃했거나 로그인이 만료됐을 때, 로그인 화면 위에 자재 내용이
            // 보이고 삭제 버튼까지 눌리는 상태가 됩니다. 그래서 열린 팝업을 모두 닫습니다.
            for (const dlg of document.querySelectorAll("dialog[open]")) dlg.close();
            // 입력 폼이 있는 화면은 로그아웃 시점에 비웁니다. 일반 사용자는 공용 계정 하나를
            // 함께 쓰기 때문에, 다음 사람이 같은 계정으로 들어와도 앞사람이 골라둔 것이
            // 남아 있으면 안 됩니다(로그인 때만 비우면 이메일이 같아 그냥 지나갑니다).
            usagePage.setUser(null, false);
            repairsPage.setUser(null);
            // 등록·구매요청은 권한도 함께 받으므로 로그아웃 상태(권한 없음)로 넘깁니다.
            registerPage.setUser(null, false);
            purchasePage.setUser(null, false);
            // 자재 목록도 권한을 함께 받으므로 로그아웃 상태(권한 없음)로 넘깁니다.
            materialsPage.setUser(null, false, false);
            // 구매 필요 알림도 비웁니다. 입력 폼도 권한 구분도 없는 화면이지만, 표를
            // 안 비우면 다음 사람이 그 메뉴를 열었을 때 앞사람 행이 그대로 다시 그려집니다.
            alertPage.setUser(null);
        } finally {
            show(loginView);
        }
    }
}


loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();

    // 처리하는 동안 버튼을 잠가서 두 번 눌리는 것을 막습니다.
    loginBtn.disabled = true;
    loginBtn.textContent = "로그인 중...";
    try {
        await signIn(
            document.getElementById("email").value.trim(),
            document.getElementById("password").value,
        );
        // 화면 전환은 아래 onAuthChange가 알아서 해줍니다.
    } catch (err) {
        showError(err.message);
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = "로그인";
    }
});


document.getElementById("logout-btn").addEventListener("click", async () => {
    await signOut();
    document.getElementById("password").value = "";
});


// 요약 카드에서도 페이지를 열 수 있게 선택자를 넓혔습니다.
// 위쪽 goToPage 안의 .active 표시는 .nav-btn 그대로 두어야 합니다.
// 여기까지 넓히면 요약 카드에도 현재 위치 표시가 붙습니다.
for (const btn of document.querySelectorAll("[data-page]")) {
    btn.addEventListener("click", () => goToPage(btn.dataset.page));
}


// 각 화면의 버튼 동작을 연결합니다. 로그인 여부와 상관없이 한 번만 하면 됩니다.
boqPage.init();
// 자재 목록에서 자재를 고르면 그 자재로 출고 등록을 시작할 수 있게 연결합니다.
// 자재를 찾는 일은 자재 목록 표가 이미 잘하므로(컬럼마다 검색), 거기서 고른 것을
// 그대로 넘겨 출고 화면에서 다시 찾지 않게 합니다.
materialsPage.init((materialId) => {
    goToPage("usage");
    usagePage.selectPart(materialId);
});
purchasePage.init();
repairsPage.init();
registerPage.init();
alertPage.init();
// 사용이력 표에서 설비를 고르면 그 ID로 BOQ 검색 화면으로 넘어가게 연결합니다.
usagePage.init((equipmentId) => {
    goToPage("boq");
    document.getElementById("boq-input").value = equipmentId;
    boqPage.search(equipmentId);
});

// 재고나 자재를 바꾸는 동작이 끝나면 화면들이 여기로 알려옵니다(위의 REFRESHABLE 설명 참고).
// 맨 위 요약도 같이 다시 셉니다 — 같은 화면에 머무른 채 출고를 계속 등록하면 goToPage가
// 안 불려서, "표준재고 부족" 카드가 옛 숫자로 남기 때문입니다.
onDataChanged(() => {
    for (const page of REFRESHABLE) page.invalidate();
    loadSummary();
});

// 로그인 후 정해진 시간이 지났으면 로그아웃시킵니다. 페이지를 열자마자 먼저 한 번
// 끝까지 확인합니다 — 오래 전에 로그인해두고 브라우저를 닫아뒀다 다시 연 경우,
// 만료 확인이 끝나기 "전에" 아래 로그인 감지가 먼저 붙어버리면 이전 사람의 화면이
// 잠깐 그려졌다가 로그아웃되는 순간이 생깁니다. 그래서 이 확인을 먼저 완전히
// 끝내고 나서 로그인 감지를 겁니다. 이후로는 1분마다 계속 확인합니다.
await enforceMaxSession();
setInterval(enforceMaxSession, 60 * 1000);

// 로그인/로그아웃이 일어나면 화면을 다시 그립니다. 다른 탭에서 로그아웃해도 여기로 들어옵니다.
onAuthChange(render);

// 페이지를 처음 열었을 때 한 번 확인합니다.
render(await getSession());

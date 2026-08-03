// 화면 전환(로그인 ↔ 앱, 메뉴 간 이동)을 담당합니다.
import { getSession, getRole, signIn, signOut, onAuthChange } from "./auth.js";
import { getDashboardSummary } from "./db.js";
import * as boqPage from "./pages/boq.js";
import * as materialsPage from "./pages/materials.js";

const loadingView = document.getElementById("loading-view");
const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");

// 메뉴 이름과, 그 메뉴를 열 때 할 일을 짝지어 둡니다.
const PAGES = {
    boq: { load: null },
    materials: { load: () => materialsPage.load() },
};

let currentPage = "boq";


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
}


// 맨 위 요약 카드를 채웁니다. 자재 목록 전체를 받지 않고 숫자 3개만 세어 옵니다.
async function loadSummary() {
    try {
        const s = await getDashboardSummary();
        document.getElementById("m-total").textContent = `${s.total.toLocaleString()}건`;
        document.getElementById("m-categories").textContent = `${s.categories}개`;
        document.getElementById("m-need").textContent = `${s.needPurchase}건`;

        const warn = document.getElementById("need-warning");
        if (s.needPurchase > 0) {
            warn.textContent = `⚠️ 표준재고보다 부족한 자재가 ${s.needPurchase}건 있습니다.`;
            warn.classList.remove("hidden");
        } else {
            warn.classList.add("hidden");
        }
    } catch {
        // 요약 카드는 부가 정보라, 못 가져와도 화면 전체를 막지는 않습니다.
        document.getElementById("m-total").textContent = "-";
    }
}


function render(session) {
    if (session) {
        document.getElementById("user-email").textContent = session.user.email;
        document.getElementById("user-role").textContent = getRole(session);
        show(appView);
        loadSummary();
        goToPage(currentPage);
    } else {
        show(loginView);
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


for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.addEventListener("click", () => goToPage(btn.dataset.page));
}


// 각 화면의 버튼 동작을 연결합니다. 로그인 여부와 상관없이 한 번만 하면 됩니다.
boqPage.init();
materialsPage.init();

// 로그인/로그아웃이 일어나면 화면을 다시 그립니다. 다른 탭에서 로그아웃해도 여기로 들어옵니다.
onAuthChange(render);

// 페이지를 처음 열었을 때 한 번 확인합니다.
render(await getSession());

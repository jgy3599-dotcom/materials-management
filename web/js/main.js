// 화면 전환(로그인 ↔ 앱)을 담당합니다.
import { getSession, getRole, signIn, signOut, onAuthChange } from "./auth.js";

const loadingView = document.getElementById("loading-view");
const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");


// 세 화면 중 하나만 보이게 합니다.
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


// 로그인 여부에 따라 알맞은 화면을 띄웁니다.
function render(session) {
    if (session) {
        document.getElementById("user-email").textContent = session.user.email;
        document.getElementById("user-role").textContent = getRole(session);
        show(appView);
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


// 로그인/로그아웃이 일어나면 화면을 다시 그립니다. 다른 탭에서 로그아웃해도 여기로 들어옵니다.
onAuthChange(render);

// 페이지를 처음 열었을 때 한 번 확인합니다.
render(await getSession());

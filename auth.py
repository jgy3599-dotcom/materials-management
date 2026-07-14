import time
import streamlit as st
from db import get_client, get_authed_client

# 비밀번호를 몇 번 이상 틀리면 일정 시간 동안 로그인 시도를 막아서, 무차별 대입 시도를 어렵게 만듭니다.
LOGIN_MAX_ATTEMPTS = 5
LOGIN_LOCKOUT_SECONDS = 300


# 로그인 여부를 확인합니다. 아직 로그인 안 했으면 이메일/비밀번호 입력 화면만 보여주고, 이후 코드는 실행하지 않습니다.
def check_login():
    if "role" in st.session_state:
        return

    if "login_fail_count" not in st.session_state:
        st.session_state.login_fail_count = 0
        st.session_state.locked_until = 0

    st.title("📦 자재관리 시스템")
    st.subheader("로그인")

    now = time.time()
    if now < st.session_state.locked_until:
        remaining = int(st.session_state.locked_until - now)
        st.error(f"로그인을 너무 많이 실패했습니다. {remaining}초 후 다시 시도해주세요.")
        st.stop()

    email = st.text_input("이메일")
    password = st.text_input("비밀번호", type="password")
    if st.button("로그인"):
        try:
            res = get_client().auth.sign_in_with_password({"email": email, "password": password})
            st.session_state.access_token = res.session.access_token
            st.session_state.refresh_token = res.session.refresh_token
            st.session_state.role = (res.user.user_metadata or {}).get("role", "일반")
            st.session_state.user_email = res.user.email
            st.session_state.login_fail_count = 0
            st.rerun()
        except Exception:
            st.session_state.login_fail_count += 1
            if st.session_state.login_fail_count >= LOGIN_MAX_ATTEMPTS:
                st.session_state.locked_until = now + LOGIN_LOCKOUT_SECONDS
                st.error(f"로그인을 {LOGIN_MAX_ATTEMPTS}번 실패해서 {LOGIN_LOCKOUT_SECONDS // 60}분 동안 잠깁니다.")
            else:
                st.error("이메일 또는 비밀번호가 올바르지 않습니다.")
    st.stop()


# 사이드바에 로그인한 계정과 권한을 보여주고, 로그아웃 버튼을 둡니다.
def render_sidebar():
    with st.sidebar:
        st.write(f"{st.session_state.user_email}")
        st.write(f"권한: **{st.session_state.role}**")
        if st.button("로그아웃"):
            try:
                get_authed_client().auth.sign_out()
            except Exception:
                pass
            for key in ["role", "access_token", "refresh_token", "user_email"]:
                st.session_state.pop(key, None)
            st.rerun()

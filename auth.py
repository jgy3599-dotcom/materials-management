import time
import streamlit as st
from db import get_client, get_authed_client

# 비밀번호를 몇 번 이상 틀리면 일정 시간 동안 로그인 시도를 막아서, 무차별 대입 시도를 어렵게 만듭니다.
# 여러 사람이 공용 계정을 함께 쓰다가 오타로 잠기는 일이 없도록 횟수는 넉넉하게 둡니다.
LOGIN_MAX_ATTEMPTS = 10
LOGIN_LOCKOUT_SECONDS = 300
# 이 시간보다 오래된 실패는 잊습니다. 사무실 직원들은 NAT 때문에 전부 같은 공인 IP로 묶이는데,
# 시간 제한이 없으면 며칠에 걸쳐 조금씩 쌓인 실패로 사무실 전체가 잠겨버립니다.
LOGIN_FAILURE_WINDOW_SECONDS = 900


# 로그인 실패 시각을 담아두는 기록장입니다. {구분키: [실패시각, 실패시각, ...]} 형태로 들어갑니다.
# st.cache_resource로 감싸두면 서버가 켜져있는 동안 모든 접속자가 이 dict 하나를 함께 씁니다.
# session_state와 달리 브라우저를 새로고침해도 사라지지 않아서, 새로고침으로 잠금을 우회하는 걸 막습니다.
@st.cache_resource
def _login_failures():
    return {}


# 실패 횟수를 누구 기준으로 셀지 정합니다. 이메일이 아니라 접속한 IP를 씁니다.
# 일반 계정은 여러 사람이 공용으로 쓰는데, 이메일 기준으로 잠그면 외부인이 그 계정 비밀번호를
# 일부러 틀려서 팀 전체를 못 들어오게 만들 수 있습니다. IP 기준이면 공격자 본인만 잠깁니다.
#
# 프록시나 컨테이너 환경에서는 IP를 못 읽어 None이 올 수 있습니다. 그때 모두를 한 칸에 몰아넣으면
# 누군가 10번 틀리는 것만으로 전체가 못 들어오게 되므로, 차라리 잠금을 걸지 않고
# Supabase 자체 rate limit에 맡깁니다. (None을 돌려주면 아래에서 잠금을 건너뜁니다.)
def _attempt_key():
    return st.context.ip_address


# 로그인 여부를 확인합니다. 아직 로그인 안 했으면 이메일/비밀번호 입력 화면만 보여주고, 이후 코드는 실행하지 않습니다.
def check_login():
    if "role" in st.session_state:
        return

    # key가 None이면(IP를 못 읽는 환경) failures도 None으로 두고 잠금 기능을 아예 쓰지 않습니다.
    key = _attempt_key()
    failures = _login_failures() if key else None

    st.title("📦 자재관리 시스템")
    st.subheader("로그인")

    # ▼▼▼ [임시 진단] 확인이 끝나면 이 블록(주석 4줄 + caption 1줄)을 지우세요. ▼▼▼
    # 프록시/컨테이너 뒤에서는 모든 접속자가 같은 IP로 보일 수 있는데, 그러면 외부인 한 명이
    # 10번 틀리는 것만으로 전체가 잠길 수 있습니다. 서로 다른 네트워크의 두 사람(예: 사무실
    # PC와 휴대폰 LTE)이 이 값을 봤을 때 서로 다르면 정상, 같으면 프록시 문제입니다.
    st.caption(f"[임시 진단] 이 앱이 보는 접속 IP: {st.context.ip_address!r}")
    # ▲▲▲ [임시 진단] 여기까지 ▲▲▲

    now = time.time()

    # 시간 창(최근 LOGIN_FAILURE_WINDOW_SECONDS초) 안의 실패만 남기고 오래된 건 버립니다.
    recent = []
    if failures is not None:
        recent = [t for t in failures.get(key, []) if t > now - LOGIN_FAILURE_WINDOW_SECONDS]
        failures[key] = recent

    if len(recent) >= LOGIN_MAX_ATTEMPTS:
        unlock_at = recent[-1] + LOGIN_LOCKOUT_SECONDS
        if now < unlock_at:
            st.error(f"로그인을 너무 많이 실패했습니다. {int(unlock_at - now)}초 후 다시 시도해주세요.")
            st.stop()
        # 잠금 시간이 지났으면 실패 기록을 비웁니다. 이걸 안 하면 기록이 그대로 남아있어서
        # 잠금이 풀린 뒤 딱 한 번만 틀려도 곧바로 또 잠기게 됩니다.
        recent = []
        failures[key] = recent

    # form으로 감싸두면, 입력칸에서 Enter 키를 눌러도 제출 버튼을 누른 것처럼 동작합니다.
    with st.form("login_form"):
        email = st.text_input("이메일")
        password = st.text_input("비밀번호", type="password")
        submitted = st.form_submit_button("로그인")

    if submitted:
        try:
            res = get_client().auth.sign_in_with_password({"email": email, "password": password})
            st.session_state.access_token = res.session.access_token
            st.session_state.refresh_token = res.session.refresh_token
            st.session_state.role = (res.user.user_metadata or {}).get("role", "일반")
            st.session_state.user_email = res.user.email
            if failures is not None:
                failures.pop(key, None)
            st.rerun()
        except Exception:
            # recent는 failures[key]와 같은 리스트라, 여기 추가하면 기록장에도 바로 반영됩니다.
            if failures is not None:
                recent.append(now)
            remaining_tries = LOGIN_MAX_ATTEMPTS - len(recent)

            if failures is None:
                st.error("이메일 또는 비밀번호가 올바르지 않습니다.")
            elif remaining_tries <= 0:
                st.error(f"로그인을 {LOGIN_MAX_ATTEMPTS}번 실패해서 {LOGIN_LOCKOUT_SECONDS // 60}분 동안 잠깁니다.")
            else:
                st.error(f"이메일 또는 비밀번호가 올바르지 않습니다. ({remaining_tries}번 더 틀리면 잠깁니다.)")
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

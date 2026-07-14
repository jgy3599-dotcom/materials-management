import streamlit as st
import pandas as pd
import altair as alt
import io
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
from datetime import date
from supabase import create_client
from postgrest.exceptions import APIError

# 차트에서 카테고리마다 항상 같은 색을 쓰도록 고정해둔 표입니다.
# (필터링을 해도 색이 바뀌면 헷갈리기 때문에, 카테고리:색을 1:1로 고정합니다.)
CATEGORY_COLORS = {
    "롤러/풀리/스프라켓": "#2a78d6",
    "벨트류": "#1baf7a",
    "베어링/바퀴": "#eda100",
    "모터": "#008300",
    "전기": "#4a3aa7",
    "스위치": "#e34948",
    "외산(TAMS)": "#e87ba4",
    "외산": "#eb6834",
}

# 웹 브라우저 탭 제목과 화면 전체 너비를 설정합니다.
st.set_page_config(page_title="자재관리 시스템", layout="wide")

# Supabase 서버에 접속하는 연결 객체를 만듭니다.
# cache_resource로 감싸두면, 화면이 다시 그려질 때마다 매번 새로 연결하지 않고 재사용합니다.
@st.cache_resource
def get_client():
    return create_client(st.secrets["supabase"]["url"], st.secrets["supabase"]["key"])

supabase = get_client()

# Supabase 테이블의 영문 컬럼명을 화면에 보여줄 한글 이름으로 바꿔주는 매핑표입니다.
MATERIAL_COLUMNS = {
    "id": "id",
    "category": "카테고리",
    "part_name": "부품명(규격)",
    "install_location": "설치위치",
    "manufacturer": "제조사",
    "vendor": "거래처",
    "in_use_qty": "적용수량",
    "standard_qty": "표준재고",
    "current_qty": "현재재고",
    "note": "비고",
}

# materials 테이블 전체를 가져와서 한글 컬럼명이 붙은 표로 만들어줍니다.
# Supabase는 한 번 요청에 최대 1000건까지만 돌려주므로, 1000건씩 끊어서 끝까지 반복해서 가져옵니다.
def load_materials():
    page_size = 1000
    rows = []
    start = 0
    while True:
        res = supabase.table("materials").select("*").order("id").range(start, start + page_size - 1).execute()
        rows.extend(res.data)
        if len(res.data) < page_size:
            break
        start += page_size
    df = pd.DataFrame(rows, columns=MATERIAL_COLUMNS.keys())
    return df.rename(columns=MATERIAL_COLUMNS)

# history 테이블을 가져오면서, 연결된 자재의 부품명도 같이 붙여서 보여줍니다.
# materials와 마찬가지로 1000건씩 끊어서 끝까지 반복해서 가져옵니다.
def load_history():
    page_size = 1000
    data = []
    start = 0
    while True:
        res = supabase.table("history").select("*, materials(part_name)").order("id").range(start, start + page_size - 1).execute()
        data.extend(res.data)
        if len(res.data) < page_size:
            break
        start += page_size

    rows = [
        {
            "일자": row["occurred_on"],
            "구분": row["direction"],
            "부품명(규격)": row["materials"]["part_name"] if row.get("materials") else None,
            "수량": row["quantity"],
            "담당자": row["manager"],
            "비고": row["note"],
        }
        for row in data
    ]
    return pd.DataFrame(rows, columns=["일자", "구분", "부품명(규격)", "수량", "담당자", "비고"])

# 표준재고에서 현재재고를 뺀 값(구매필요 수량)을 매번 다시 계산해서 표에 붙여줍니다.
def with_구매필요(df):
    result = df.copy()
    result["구매필요"] = result["표준재고"] - result["현재재고"]
    return result

# 구매가 필요한 자재 목록을 엑셀 파일로 첨부해서 네이버 메일로 보내는 함수입니다.
# secrets.toml의 [naver_mail]에 적어둔 계정으로 로그인해서, 같은 계정 앞으로 메일을 보냅니다.
def send_purchase_alert_email(need_purchase_df):
    sender = st.secrets["naver_mail"]["sender_email"]
    password = st.secrets["naver_mail"]["app_password"]

    # 표를 엑셀 파일로 만들되, 디스크에 저장하지 않고 메모리(BytesIO)에서 바로 만듭니다.
    excel_buffer = io.BytesIO()
    need_purchase_df.to_excel(excel_buffer, index=False, engine="openpyxl")
    excel_buffer.seek(0)

    msg = MIMEMultipart()
    msg["Subject"] = f"[자재관리] 구매 필요 알림 ({len(need_purchase_df)}건)"
    msg["From"] = sender
    msg["To"] = sender
    msg.attach(MIMEText(f"구매가 필요한 자재 {len(need_purchase_df)}건을 첨부 엑셀 파일로 보내드립니다."))

    attachment = MIMEApplication(excel_buffer.read(), _subtype="xlsx")
    # 첨부파일 이름에 한글을 쓰면 메일 프로그램에 따라 깨질 수 있어 영문 파일명을 사용합니다.
    attachment.add_header("Content-Disposition", "attachment", filename="purchase_needed_list.xlsx")
    msg.attach(attachment)

    # 465번 포트 + SSL은 네이버 메일이 요구하는 SMTP 접속 방식입니다.
    with smtplib.SMTP_SSL("smtp.naver.com", 465) as server:
        server.login(sender, password)
        server.sendmail(sender, [sender], msg.as_string())

# "✏️ 수정/삭제 열기" 버튼을 누르면 뜨는 팝업창입니다.
# st.dialog로 감싼 함수는 화면 가운데에 모달(팝업)로 뜹니다.
@st.dialog("자재 수정 / 삭제")
def edit_material_dialog(material_id):
    res = supabase.table("materials").select("*").eq("id", material_id).execute()
    if not res.data:
        st.error("이 자재를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.")
        return
    row = res.data[0]

    with st.form("edit_form"):
        col1, col2 = st.columns(2)
        with col1:
            category = st.text_input("카테고리", value=row["category"] or "")
            part = st.text_input("부품명(규격)", value=row["part_name"] or "")
            location = st.text_input("설치위치", value=row["install_location"] or "")
            manufacturer = st.text_input("제조사", value=row["manufacturer"] or "")
        with col2:
            vendor = st.text_input("거래처", value=row["vendor"] or "")
            in_use_qty = st.number_input("적용수량", min_value=0, step=1, value=int(row["in_use_qty"] or 0))
            standard_qty = st.number_input("표준재고", min_value=0, step=1, value=int(row["standard_qty"] or 0))
            current_qty = st.number_input("현재재고", min_value=0, step=1, value=int(row["current_qty"] or 0))
        note = st.text_input("비고", value=row["note"] or "")

        col_save, col_delete, col_close = st.columns(3)
        with col_save:
            save_clicked = st.form_submit_button("수정 저장", use_container_width=True)
        with col_delete:
            delete_clicked = st.form_submit_button("삭제하기", use_container_width=True, type="primary")
        with col_close:
            close_clicked = st.form_submit_button("닫기", use_container_width=True)

        if save_clicked:
            if not part:
                st.error("부품명(규격)은 반드시 입력해야 합니다.")
            else:
                supabase.table("materials").update({
                    "category": category, "part_name": part, "install_location": location,
                    "manufacturer": manufacturer, "vendor": vendor, "in_use_qty": in_use_qty,
                    "standard_qty": standard_qty, "current_qty": current_qty, "note": note,
                }).eq("id", material_id).execute()
                st.success(f"'{part}' 자재가 수정되었습니다.")
                st.rerun()

        if close_clicked:
            st.rerun()

        if delete_clicked:
            try:
                supabase.table("materials").delete().eq("id", material_id).execute()
                st.success(f"'{row['part_name']}' 자재가 삭제되었습니다.")
                st.rerun()
            except APIError:
                # 이 자재를 참조하는 입출고 이력이 남아있으면 삭제가 거부됩니다.
                st.error("이 자재는 입출고 이력이 남아있어 삭제할 수 없습니다. 이력을 먼저 정리해주세요.")

# 로그인 여부를 확인합니다. 아직 로그인 안 했으면 비밀번호 입력 화면만 보여주고, 이후 코드는 실행하지 않습니다.
def check_login():
    if "role" in st.session_state:
        return
    st.title("📦 자재관리 시스템")
    st.subheader("로그인")
    password = st.text_input("비밀번호", type="password")
    if st.button("로그인"):
        if password == st.secrets["auth"]["admin_password"]:
            st.session_state.role = "관리자"
            st.rerun()
        elif password == st.secrets["auth"]["general_password"]:
            st.session_state.role = "일반"
            st.rerun()
        else:
            st.error("비밀번호가 올바르지 않습니다.")
    st.stop()

check_login()

with st.sidebar:
    st.write(f"현재 권한: **{st.session_state.role}**")
    if st.button("로그아웃"):
        del st.session_state.role
        st.rerun()

# 화면 맨 위에 제목을 표시합니다.
st.title("📦 자재관리 시스템")

# 탭에 들어가지 않아도 바로 보이도록, 구매가 필요한 자재 건수를 제목 아래에 항상 띄워둡니다.
_materials_for_alert = with_구매필요(load_materials())
_need_purchase_count = int((_materials_for_alert["구매필요"] > 0).sum())
if _need_purchase_count > 0:
    st.warning(f"⚠️ 표준재고보다 부족한 자재가 **{_need_purchase_count}건** 있습니다. '⚠️ 구매 필요 알림' 탭에서 확인하세요.")

# tabs()는 화면 안에 탭(클릭해서 전환하는 페이지)을 여러 개 만들어줍니다.
tab1, tab2, tab3, tab4, tab5, tab6 = st.tabs(
    ["📋 자재 목록", "➕ 자재 등록", "🔄 입출고 이력", "🔍 검색/필터", "⚠️ 구매 필요 알림", "📊 통계 대시보드"]
)

# ---------- 탭 1: 자재 목록 ----------
with tab1:
    st.subheader("전체 자재 목록")
    materials = load_materials()
    # dataframe()은 표(엑셀처럼 행/열이 있는 데이터)를 화면에 보여줍니다. (여기서는 그냥 보기만 합니다)
    st.dataframe(with_구매필요(materials), use_container_width=True)
    st.caption(f"총 {len(materials)}건의 자재가 등록되어 있습니다.")

    st.divider()
    if st.session_state.role != "관리자":
        st.caption("✏️ 자재 수정/삭제는 관리자만 가능합니다.")
    else:
        st.markdown("**✏️ 자재 수정/삭제**")
        st.caption("카테고리나 검색어로 좁힌 뒤, 원하는 자재 옆의 ✏️ 버튼을 누르면 수정/삭제 창이 뜹니다.")

        if materials.empty:
            st.info("먼저 '자재 등록' 탭에서 자재를 하나 이상 등록해주세요.")
        else:
            col_cat, col_kw = st.columns(2)
            with col_cat:
                edit_category_list = ["전체"] + sorted(materials["카테고리"].dropna().unique().tolist())
                edit_selected_category = st.selectbox("카테고리", edit_category_list, key="edit_category")
            with col_kw:
                edit_keyword = st.text_input("부품명(규격) 검색", key="edit_keyword")

            narrowed = materials
            if edit_selected_category != "전체":
                narrowed = narrowed[narrowed["카테고리"] == edit_selected_category]
            if edit_keyword:
                narrowed = narrowed[narrowed["부품명(규격)"].str.contains(edit_keyword, case=False, na=False)]

            # 행마다 아이콘 버튼을 직접 그리는 방식은 개수가 많아지면 느려지므로, 결과가 너무 많으면
            # 버튼 목록 대신 안내만 보여주고 더 좁혀달라고 요청합니다.
            MAX_EDIT_ROWS = 30
            st.caption(f"검색 결과: {len(narrowed)}건")
            if len(narrowed) == 0:
                st.info("조건에 맞는 자재가 없습니다.")
            elif len(narrowed) > MAX_EDIT_ROWS:
                st.warning(f"결과가 {len(narrowed)}건이라 너무 많습니다. 카테고리나 검색어로 {MAX_EDIT_ROWS}건 이하로 좁혀주세요.")
            else:
                header = st.columns([2, 3, 2, 2, 1])
                header[0].markdown("**카테고리**")
                header[1].markdown("**부품명(규격)**")
                header[2].markdown("**현재재고**")
                header[3].markdown("**구매필요**")
                header[4].markdown("**수정**")
                for _, r in narrowed.iterrows():
                    c1, c2, c3, c4, c5 = st.columns([2, 3, 2, 2, 1])
                    c1.write(r["카테고리"])
                    c2.write(r["부품명(규격)"])
                    c3.write(r["현재재고"])
                    c4.write(r["표준재고"] - r["현재재고"])
                    if c5.button("✏️", key=f"edit_btn_{int(r['id'])}", use_container_width=True):
                        edit_material_dialog(int(r["id"]))

# ---------- 탭 2: 자재 등록 ----------
with tab2:
    st.subheader("새 자재 등록")
    # form()으로 감싼 입력창들은 "등록하기" 버튼을 눌러야 한번에 처리됩니다.
    with st.form("register_form", clear_on_submit=True):
        col1, col2 = st.columns(2)
        with col1:
            category = st.text_input("카테고리")
            part = st.text_input("부품명(규격)")
            location = st.text_input("설치위치")
            manufacturer = st.text_input("제조사", value="-")
        with col2:
            vendor = st.text_input("거래처", value="-")
            in_use_qty = st.number_input("적용수량", min_value=0, step=1)
            standard_qty = st.number_input("표준재고", min_value=0, step=1)
            current_qty = st.number_input("현재재고", min_value=0, step=1)
        note = st.text_input("비고")

        # form_submit_button은 form 안에서 제출 버튼 역할을 합니다.
        submitted = st.form_submit_button("등록하기")

        if submitted:
            if not part:
                st.error("부품명(규격)은 반드시 입력해야 합니다.")
            else:
                # Supabase의 materials 테이블에 새 행을 저장합니다.
                supabase.table("materials").insert({
                    "category": category, "part_name": part, "install_location": location,
                    "manufacturer": manufacturer, "vendor": vendor, "in_use_qty": in_use_qty,
                    "standard_qty": standard_qty, "current_qty": current_qty, "note": note,
                }).execute()
                st.success(f"'{part}' 자재가 등록되었습니다.")
                st.rerun()

# ---------- 탭 3: 입출고 이력 ----------
with tab3:
    st.subheader("입출고 이력")
    st.dataframe(load_history(), use_container_width=True)

    st.divider()
    st.subheader("입출고 등록")
    materials = load_materials()

    if materials.empty:
        st.info("먼저 '자재 등록' 탭에서 자재를 하나 이상 등록해주세요.")
    else:
        # 카테고리 선택은 form 밖에 둬야, 고를 때마다 바로바로 아래 부품 목록이 좁혀집니다.
        # (form 안에 넣으면 "등록하기"를 눌러야만 반영되기 때문입니다.)
        category_list = ["전체"] + sorted(materials["카테고리"].dropna().unique().tolist())
        selected_category = st.selectbox("카테고리로 먼저 좁히기", category_list)

        if selected_category == "전체":
            narrowed = materials
        else:
            narrowed = materials[materials["카테고리"] == selected_category]

        with st.form("history_form", clear_on_submit=True):
            col1, col2 = st.columns(2)
            with col1:
                selected_part = st.selectbox("부품명(규격)", narrowed["부품명(규격)"].tolist())
                direction = st.radio("구분", ["입고", "출고"], horizontal=True)
            with col2:
                move_qty = st.number_input("수량", min_value=1, step=1)
                move_date = st.date_input("일자", value=date.today())
            manager = st.text_input("담당자")
            note = st.text_input("비고")

            submitted = st.form_submit_button("등록하기")

            if submitted:
                material_row = narrowed[narrowed["부품명(규격)"] == selected_part].iloc[0]
                material_id = int(material_row["id"])

                # history 테이블에 이번 입출고 기록을 추가합니다.
                supabase.table("history").insert({
                    "occurred_on": move_date.isoformat(), "direction": direction,
                    "material_id": material_id, "quantity": move_qty,
                    "manager": manager, "note": note,
                }).execute()

                # 입고면 현재재고를 늘리고, 출고면 현재재고를 줄여서 materials 테이블에도 반영합니다.
                change = move_qty if direction == "입고" else -move_qty
                new_qty = int(material_row["현재재고"]) + change
                supabase.table("materials").update({"current_qty": new_qty}).eq("id", material_id).execute()

                st.success(f"'{selected_part}' {direction} {move_qty}건이 등록되었습니다.")
                st.rerun()

# ---------- 탭 4: 검색/필터 ----------
with tab4:
    st.subheader("검색 / 필터")
    materials = load_materials()
    col1, col2 = st.columns(2)
    with col1:
        keyword = st.text_input("부품명(규격)으로 검색")
    with col2:
        # 현재 데이터에 있는 카테고리 값들을 중복 없이 뽑아서 선택지로 만듭니다.
        category_list = ["전체"] + sorted(materials["카테고리"].dropna().unique().tolist())
        selected_category = st.selectbox("카테고리로 필터", category_list)

    # 원본 데이터를 건드리지 않도록 복사본을 만들어서 조건에 맞게 걸러냅니다.
    filtered = with_구매필요(materials)
    if keyword:
        filtered = filtered[filtered["부품명(규격)"].str.contains(keyword, case=False, na=False)]
    if selected_category != "전체":
        filtered = filtered[filtered["카테고리"] == selected_category]

    st.dataframe(filtered, use_container_width=True)
    st.caption(f"검색 결과: {len(filtered)}건")

# ---------- 탭 5: 구매 필요 알림 ----------
with tab5:
    st.subheader("구매가 필요한 자재")
    need_purchase = _materials_for_alert[_materials_for_alert["구매필요"] > 0].copy()
    # 부족한 정도가 큰 자재부터 위에 보이도록 정렬합니다.
    need_purchase = need_purchase.sort_values("구매필요", ascending=False)

    st.metric("구매 필요 자재 건수", f"{len(need_purchase)}건")

    category_list = ["전체"] + sorted(need_purchase["카테고리"].dropna().unique().tolist())
    selected_category = st.selectbox("카테고리로 좁히기", category_list, key="alert_category")
    if selected_category != "전체":
        need_purchase = need_purchase[need_purchase["카테고리"] == selected_category]

    st.dataframe(need_purchase, use_container_width=True)

    st.divider()
    if st.button("📧 알림 메일 보내기"):
        if need_purchase.empty:
            st.info("현재 구매가 필요한 자재가 없어 보낼 내용이 없습니다.")
        else:
            try:
                send_purchase_alert_email(need_purchase)
                st.success(f"{st.secrets['naver_mail']['sender_email']}로 알림 메일을 보냈습니다.")
            except Exception as e:
                st.error(f"메일 발송에 실패했습니다: {e}")

# ---------- 탭 6: 통계 대시보드 ----------
with tab6:
    st.subheader("통계 대시보드")
    materials = _materials_for_alert
    history_df = load_history()

    # 요약 숫자 4개를 카드로 보여줍니다.
    col1, col2, col3, col4 = st.columns(4)
    col1.metric("전체 자재 종류", f"{len(materials)}건")
    col2.metric("카테고리 수", f"{materials['카테고리'].nunique()}개")
    col3.metric("구매 필요 자재", f"{int((materials['구매필요'] > 0).sum())}건")
    col4.metric("전체 입출고 이력", f"{len(history_df)}건")

    st.divider()

    col_left, col_right = st.columns(2)

    with col_left:
        st.markdown("**카테고리별 자재 건수**")
        cat_counts = materials["카테고리"].value_counts().reset_index()
        cat_counts.columns = ["카테고리", "건수"]
        chart1 = alt.Chart(cat_counts).mark_bar(cornerRadiusTopLeft=4, cornerRadiusTopRight=4).encode(
            x=alt.X("카테고리:N", sort="-y", title=None),
            y=alt.Y("건수:Q", title="건수"),
            color=alt.Color(
                "카테고리:N",
                scale=alt.Scale(domain=list(CATEGORY_COLORS.keys()), range=list(CATEGORY_COLORS.values())),
                legend=None,
            ),
            tooltip=["카테고리", "건수"],
        ).properties(height=320)
        st.altair_chart(chart1, use_container_width=True)

    with col_right:
        st.markdown("**카테고리별 구매 필요 건수**")
        need_by_cat = materials[materials["구매필요"] > 0]["카테고리"].value_counts().reset_index()
        need_by_cat.columns = ["카테고리", "건수"]
        if need_by_cat.empty:
            st.info("현재 구매가 필요한 자재가 없습니다.")
        else:
            chart2 = alt.Chart(need_by_cat).mark_bar(cornerRadiusTopLeft=4, cornerRadiusTopRight=4).encode(
                x=alt.X("카테고리:N", sort="-y", title=None),
                y=alt.Y("건수:Q", title="건수"),
                color=alt.Color(
                    "카테고리:N",
                    scale=alt.Scale(domain=list(CATEGORY_COLORS.keys()), range=list(CATEGORY_COLORS.values())),
                    legend=None,
                ),
                tooltip=["카테고리", "건수"],
            ).properties(height=320)
            st.altair_chart(chart2, use_container_width=True)

    st.divider()
    st.markdown("**월별 입출고 추이**")
    if history_df.empty:
        st.info("입출고 이력이 없습니다.")
    else:
        trend = history_df.copy()
        trend["일자"] = pd.to_datetime(trend["일자"])
        # 원본 엑셀의 날짜 오타(2001년 등 실제 운영 시작 이전 날짜)는 그래프를 왜곡시키므로 제외합니다.
        # 자재관리가 시작된 2023-12 이전 데이터는 데이터 오류로 보고 그래프에서만 뺍니다.
        before_count = (trend["일자"] < "2023-01-01").sum()
        trend = trend[trend["일자"] >= "2023-01-01"]
        if before_count > 0:
            st.caption(f"※ 날짜 오류로 보이는 {before_count}건(2023년 이전)은 그래프에서 제외했습니다.")

        trend["연월"] = trend["일자"].dt.to_period("M").astype(str)
        monthly = trend.groupby(["연월", "구분"])["수량"].sum().reset_index()

        direction_colors = {"입고": "#2a78d6", "출고": "#e34948"}
        chart3 = alt.Chart(monthly).mark_line(point=True, strokeWidth=2).encode(
            x=alt.X("연월:N", title=None),
            y=alt.Y("수량:Q", title="수량"),
            color=alt.Color(
                "구분:N",
                scale=alt.Scale(domain=list(direction_colors.keys()), range=list(direction_colors.values())),
                legend=alt.Legend(title=None),
            ),
            tooltip=["연월", "구분", "수량"],
        ).properties(height=320)
        st.altair_chart(chart3, use_container_width=True)

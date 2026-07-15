import streamlit as st
from datetime import date
from postgrest.exceptions import APIError
import db
import auth
import mail

# 감사 로그는 관리자보다 더 높은 권한으로, 이 계정에서만 볼 수 있게 제한합니다.
# (실제 차단은 Supabase의 RLS 정책이 하고, 이건 화면에 아예 안 보이게 하는 용도입니다.)
SUPER_ADMIN_EMAIL = "gyjeong@hanjin.com"

# 웹 브라우저 탭 제목과 화면 전체 너비를 설정합니다.
st.set_page_config(page_title="자재관리 시스템", layout="wide")

# "✏️ 수정/삭제 열기" 버튼을 누르면 뜨는 팝업창입니다.
# st.dialog로 감싼 함수는 화면 가운데에 모달(팝업)로 뜹니다.
@st.dialog("자재 수정 / 삭제")
def edit_material_dialog(material_id):
    row = db.get_material(material_id)
    if not row:
        st.error("이 자재를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.")
        return

    with st.form("edit_form"):
        col1, col2 = st.columns(2)
        with col1:
            category = st.text_input("카테고리", value=row["category"] or "")
            sub_type = st.text_input("구분", value=row["sub_type"] or "")
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
                after_data = {
                    "category": category, "sub_type": sub_type or None, "part_name": part, "install_location": location,
                    "manufacturer": manufacturer, "vendor": vendor, "in_use_qty": in_use_qty,
                    "standard_qty": standard_qty, "current_qty": current_qty, "note": note,
                }
                db.update_material(material_id, after_data)
                db.insert_audit_log(st.session_state.user_email, "update", material_id, part, row, after_data)
                st.success(f"'{part}' 자재가 수정되었습니다.")
                st.rerun()

        if close_clicked:
            st.rerun()

        if delete_clicked:
            try:
                db.delete_material(material_id)
                db.insert_audit_log(st.session_state.user_email, "delete", material_id, row["part_name"], row)
                st.success(f"'{row['part_name']}' 자재가 삭제되었습니다.")
                st.rerun()
            except APIError:
                # 이 자재를 참조하는 입출고 이력이 남아있으면 삭제가 거부됩니다.
                st.error("이 자재는 입출고 이력이 남아있어 삭제할 수 없습니다. 이력을 먼저 정리해주세요.")

auth.check_login()
auth.render_sidebar()

# 화면 맨 위에 제목을 표시합니다.
st.title("📦 자재관리 시스템")

# 탭에 들어가지 않아도 바로 보이도록, 구매가 필요한 자재 건수를 제목 아래에 항상 띄워둡니다.
_materials_for_alert = db.with_구매필요(db.load_materials())
_need_purchase_count = int((_materials_for_alert["구매필요"] > 0).sum())
if _need_purchase_count > 0:
    st.warning(f"⚠️ 표준재고보다 부족한 자재가 **{_need_purchase_count}건** 있습니다. '⚠️ 구매 필요 알림' 탭에서 확인하세요.")

# tabs()는 화면 안에 탭(클릭해서 전환하는 페이지)을 여러 개 만들어줍니다.
tab1, tab2, tab3, tab4, tab5 = st.tabs(
    ["📋 자재 목록", "➕ 자재 등록", "🔄 입출고 이력", "🔍 검색/필터", "⚠️ 구매 필요 알림"]
)

# ---------- 탭 1: 자재 목록 ----------
with tab1:
    st.subheader("전체 자재 목록")
    materials = db.load_materials()
    # dataframe()은 표(엑셀처럼 행/열이 있는 데이터)를 화면에 보여줍니다. (여기서는 그냥 보기만 합니다)
    st.dataframe(db.with_구매필요(materials), use_container_width=True)
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

        if st.session_state.user_email == SUPER_ADMIN_EMAIL:
            with st.expander("🗒️ 감사 로그 (최근 수정/삭제 이력)"):
                st.dataframe(db.load_audit_log(), use_container_width=True)

# ---------- 탭 2: 자재 등록 ----------
with tab2:
    st.subheader("새 자재 등록")
    # 기존에 등록된 카테고리 목록을 뽑아서 선택지로 만듭니다. 목록에 없는 완전히 새로운
    # 카테고리를 등록해야 할 수도 있으니 "직접 입력" 옵션도 함께 둡니다.
    NEW_CATEGORY_OPTION = "➕ 새 카테고리 직접 입력"
    existing_categories = sorted(db.load_materials()["카테고리"].dropna().unique().tolist())
    category_options = existing_categories + [NEW_CATEGORY_OPTION]

    # form()으로 감싼 입력창들은 "등록하기" 버튼을 눌러야 한번에 처리됩니다.
    with st.form("register_form", clear_on_submit=True):
        col1, col2 = st.columns(2)
        with col1:
            category_choice = st.selectbox("카테고리", category_options)
            new_category = st.text_input("새 카테고리명 (위에서 '➕ 새 카테고리 직접 입력'을 골랐을 때만 입력)")
            sub_type = st.text_input("구분 (선택 입력, 예: 베어링/키/풀리)")
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
            category = new_category if category_choice == NEW_CATEGORY_OPTION else category_choice
            if not part:
                st.error("부품명(규격)은 반드시 입력해야 합니다.")
            elif category_choice == NEW_CATEGORY_OPTION and not new_category:
                st.error("새 카테고리명을 입력해주세요.")
            else:
                db.insert_material({
                    "category": category, "sub_type": sub_type or None, "part_name": part, "install_location": location,
                    "manufacturer": manufacturer, "vendor": vendor, "in_use_qty": in_use_qty,
                    "standard_qty": standard_qty, "current_qty": current_qty, "note": note,
                })
                st.success(f"'{part}' 자재가 등록되었습니다.")
                st.rerun()

# ---------- 탭 3: 입출고 이력 ----------
with tab3:
    st.subheader("입출고 이력")
    st.dataframe(db.load_history(), use_container_width=True)

    st.divider()
    st.subheader("입출고 등록")
    materials = db.load_materials()

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

            # 설비 교체 작업일 때만 채우는 선택 입력칸들입니다. (구매/입고 등록에는 비워두면 됩니다)
            st.caption("아래는 설비 교체 작업일 때만 채워주세요 (구매/입고 등록에는 비워둬도 됩니다)")
            col3, col4 = st.columns(2)
            with col3:
                equipment_id = st.text_input("설비 ID (예: LD451 RK003)")
                problem = st.text_input("문제/고장 내역")
            with col4:
                action_taken = st.text_input("조치 내역")
                part_memo = st.text_input("부품 메모")
            note = st.text_input("비고 (그 외 자유 메모)")

            submitted = st.form_submit_button("등록하기")

            if submitted:
                material_row = narrowed[narrowed["부품명(규격)"] == selected_part].iloc[0]
                material_id = int(material_row["id"])

                # history 테이블에 이번 입출고 기록을 추가합니다.
                db.insert_history({
                    "occurred_on": move_date.isoformat(), "direction": direction,
                    "material_id": material_id, "quantity": move_qty,
                    "manager": manager, "note": note or None,
                    "equipment_id": equipment_id or None, "problem": problem or None,
                    "action_taken": action_taken or None, "part_memo": part_memo or None,
                })

                # 입고면 현재재고를 늘리고, 출고면 현재재고를 줄여서 materials 테이블에도 반영합니다.
                change = move_qty if direction == "입고" else -move_qty
                new_qty = int(material_row["현재재고"]) + change
                db.update_material_qty(material_id, new_qty)

                st.success(f"'{selected_part}' {direction} {move_qty}건이 등록되었습니다.")
                st.rerun()

# ---------- 탭 4: 검색/필터 ----------
with tab4:
    st.subheader("검색 / 필터")
    materials = db.load_materials()
    col1, col2 = st.columns(2)
    with col1:
        keyword = st.text_input("부품명(규격)으로 검색")
    with col2:
        # 현재 데이터에 있는 카테고리 값들을 중복 없이 뽑아서 선택지로 만듭니다.
        category_list = ["전체"] + sorted(materials["카테고리"].dropna().unique().tolist())
        selected_category = st.selectbox("카테고리로 필터", category_list)

    # 원본 데이터를 건드리지 않도록 복사본을 만들어서 조건에 맞게 걸러냅니다.
    filtered = db.with_구매필요(materials)
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
                mail.send_purchase_alert_email(need_purchase)
                st.success(f"{st.secrets['naver_mail']['sender_email']}로 알림 메일을 보냈습니다.")
            except Exception as e:
                st.error(f"메일 발송에 실패했습니다: {e}")

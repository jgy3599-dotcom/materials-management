import io
import streamlit as st
from datetime import date
from postgrest.exceptions import APIError
import db
import auth
import mail

# 감사 로그는 관리자보다 더 높은 권한으로, 이 계정에서만 볼 수 있게 제한합니다.
# (실제 차단은 Supabase의 RLS 정책이 하고, 이건 화면에 아예 안 보이게 하는 용도입니다.)
SUPER_ADMIN_EMAIL = "gyjeong@hanjin.com"

# 표를 엑셀 바이트로 변환합니다. 같은 내용의 표면 다시 변환하지 않고 캐시된 결과를 재사용합니다.
# (버튼을 안 눌러도 화면이 다시 그려질 때마다 이 변환이 실행되므로, 캐시가 없으면 매번 낭비됩니다.)
@st.cache_data
def _to_excel_bytes(df):
    buffer = io.BytesIO()
    df.to_excel(buffer, index=False, engine="openpyxl")
    return buffer.getvalue()


# 표 하나를 엑셀 파일로 내려받는 버튼입니다. (st.dataframe 기본 다운로드 아이콘은 CSV만 지원해서 따로 만듦)
def excel_download_button(df, file_name, key):
    st.download_button(
        "📥 엑셀로 다운로드", data=_to_excel_bytes(df), file_name=file_name,
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", key=key,
    )

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
            warehouse_no = st.text_input("창고번호", value=row["warehouse_no"] or "")
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
                    "warehouse_no": warehouse_no or None,
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

# 구매 요청 하나를 다음 단계로 진행시키는 팝업창입니다. 관리자 전용입니다.
# 요청의 현재 상태에 따라 보여주는 버튼/입력칸이 달라집니다.
@st.dialog("구매 요청 처리")
def purchase_request_dialog(request_id):
    requests_df = db.load_purchase_requests()
    row = requests_df[requests_df["id"] == request_id].iloc[0]

    st.write(f"**{row['부품명(규격)']}**  (요청수량: {row['요청수량']})")
    st.caption(f"표준재고: {row['표준재고']}   /   현재재고: {row['현재재고']}")
    st.caption(f"요청자: {row['요청자']}")
    if row["요청사유"]:
        st.caption(f"요청사유: {row['요청사유']}")
    st.write(f"현재 상태: **{row['상태']}**")

    status = row["상태"]

    if status == "요청됨":
        if st.button("검토 시작", use_container_width=True):
            db.start_review(request_id)
            st.rerun()

    elif status == "검토중":
        # 재고를 확인해보니 실제로 필요한 수량이 다를 수 있어서, 승인 시점에 수량을 고칠 수 있게 합니다.
        reviewed_qty = st.number_input("승인할 수량 (필요하면 수정)", min_value=1, step=1, value=int(row["요청수량"]))
        col1, col2 = st.columns(2)
        with col1:
            if st.button("✅ 승인", use_container_width=True):
                db.approve_request(request_id, reviewed_qty)
                st.rerun()
        with col2:
            reject_reason = st.text_input("반려 사유")
            if st.button("❌ 반려", use_container_width=True):
                if not reject_reason:
                    st.error("반려 사유를 입력해주세요.")
                else:
                    db.reject_request(request_id, reject_reason)
                    st.rerun()

    elif status == "승인됨":
        with st.form("purchasing_form"):
            vendor = st.text_input("거래업체")
            unit_price = st.number_input("단가", min_value=0, step=100)
            submitted = st.form_submit_button("구매 처리 (발주 완료)")
            if submitted:
                if not vendor:
                    st.error("거래업체를 입력해주세요.")
                else:
                    db.mark_purchasing(request_id, vendor, unit_price)
                    st.rerun()

    elif status == "구매중":
        with st.form("receive_form"):
            received_qty = st.number_input("입고 수량", min_value=1, step=1, value=int(row["요청수량"]))
            submitted = st.form_submit_button("입고 처리 (재고 반영)")
            if submitted:
                db.receive_request(request_id, int(row["material_id"]), received_qty, row["거래업체"], row["단가"])
                st.success("입고 처리 완료, 현재재고에 반영되었습니다.")
                st.rerun()

    else:
        st.info("이미 종료된 요청입니다 (입고완료 또는 반려됨).")

    st.divider()
    with st.expander("🗑️ 이 요청 삭제"):
        if status == "입고완료":
            st.warning(f"입고완료 상태입니다. 삭제하면 현재재고에서 {row['입고수량']}개를 다시 빼고, 관련 입출고 이력도 함께 삭제합니다.")
        else:
            st.caption("아직 입고 전이라 재고에는 영향이 없습니다.")
        confirm = st.checkbox("삭제하겠습니다", key=f"confirm_delete_pr_{request_id}")
        if st.button("삭제", type="primary", disabled=not confirm):
            db.delete_purchase_request(request_id)
            st.success("삭제했습니다.")
            st.rerun()

auth.check_login()
auth.render_sidebar()

# 화면 맨 위에 제목을 표시합니다.
st.title("📦 자재관리 시스템")

# 자재/이력 목록은 탭 여러 곳에서 똑같이 쓰이므로, 탭마다 따로 불러오지 않고 여기서 한 번만 불러와 재사용합니다.
# (db.load_materials()/db.load_history()는 캐시되어 있어도, 매번 호출할 때마다 결과를 복사해서 돌려주기 때문에
# 여러 번 부르면 그만큼 복사 비용이 쌓입니다.)
materials_df = db.load_materials()
history_df = db.load_history()

# 탭에 들어가지 않아도 바로 보이도록, 구매가 필요한 자재 건수를 제목 아래에 항상 띄워둡니다.
_materials_for_alert = db.with_구매필요(materials_df)
_need_purchase_count = int((_materials_for_alert["구매필요"] > 0).sum())
if _need_purchase_count > 0:
    st.warning(f"⚠️ 표준재고보다 부족한 자재가 **{_need_purchase_count}건** 있습니다. '⚠️ 구매 필요 알림' 탭에서 확인하세요.")

# tabs()는 화면 안에 탭(클릭해서 전환하는 페이지)을 여러 개 만들어줍니다.
tab1, tab2, tab3, tab4, tab5, tab6, tab7 = st.tabs(
    ["📋 자재 목록", "➕ 자재 등록", "🔧 사용(출고) 이력", "🔍 검색/필터", "⚠️ 구매 필요 알림", "🛒 구매 요청", "🔎 BOQ 검색"]
)

# ---------- 탭 1: 자재 목록 ----------
with tab1:
    st.subheader("전체 자재 목록")
    materials = materials_df
    # dataframe()은 표(엑셀처럼 행/열이 있는 데이터)를 화면에 보여줍니다. (여기서는 그냥 보기만 합니다)
    st.dataframe(_materials_for_alert, use_container_width=True)
    st.caption(f"총 {len(materials)}건의 자재가 등록되어 있습니다.")
    excel_download_button(_materials_for_alert, "자재목록.xlsx", key="dl_materials")

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
    existing_categories = sorted(materials_df["카테고리"].dropna().unique().tolist())
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
            warehouse_no = st.text_input("창고번호 (선택 입력, 모터/전기/외산(TAMS)에서 사용)")
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
                    "warehouse_no": warehouse_no or None,
                })
                st.success(f"'{part}' 자재가 등록되었습니다.")
                st.rerun()

# ---------- 탭 3: 사용(출고) 이력 ----------
# 입고(구매) 이력은 '🛒 구매 요청' 탭에서 따로 관리합니다. 여기는 설비 교체 등으로
# 자재가 나간(출고) 기록만 다룹니다.
with tab3:
    st.subheader("사용(출고) 이력")
    outgoing_df = history_df[history_df["구분"] == "출고"]
    st.dataframe(outgoing_df, use_container_width=True)
    excel_download_button(outgoing_df, "사용이력.xlsx", key="dl_outgoing")

    st.divider()
    st.subheader("출고 등록")
    materials = materials_df

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
                move_qty = st.number_input("수량", min_value=1, step=1)
            with col2:
                move_date = st.date_input("일자", value=date.today())
                manager = st.text_input("담당자")

            # 설비 교체 작업일 때만 채우는 선택 입력칸들입니다.
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

                # history 테이블에 이번 출고 기록을 추가합니다.
                db.insert_history({
                    "occurred_on": move_date.isoformat(), "direction": "출고",
                    "material_id": material_id, "quantity": move_qty,
                    "manager": manager, "note": note or None,
                    "equipment_id": equipment_id or None, "problem": problem or None,
                    "action_taken": action_taken or None, "part_memo": part_memo or None,
                })

                # 출고니까 현재재고를 줄여서 materials 테이블에도 반영합니다.
                new_qty = int(material_row["현재재고"]) - move_qty
                db.update_material_qty(material_id, new_qty)

                st.success(f"'{selected_part}' 출고 {move_qty}건이 등록되었습니다.")
                st.rerun()

# ---------- 탭 4: 검색/필터 ----------
with tab4:
    st.subheader("검색 / 필터")
    materials = materials_df
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
    excel_download_button(filtered, "검색결과.xlsx", key="dl_search")

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
    excel_download_button(need_purchase, "구매필요목록.xlsx", key="dl_need_purchase")

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

# ---------- 탭 6: 구매 요청 ----------
with tab6:
    st.subheader("새 구매 요청")
    materials_for_request = materials_df

    category_list = ["전체"] + sorted(materials_for_request["카테고리"].dropna().unique().tolist())
    selected_category = st.selectbox("카테고리로 먼저 좁히기", category_list, key="pr_category")
    narrowed = materials_for_request if selected_category == "전체" else materials_for_request[materials_for_request["카테고리"] == selected_category]

    # 부품 선택은 form 밖에 둬야, 고를 때마다 바로 아래 재고 현황이 갱신됩니다.
    selected_part = st.selectbox("부품명(규격)", narrowed["부품명(규격)"].tolist())
    if selected_part:
        part_row = narrowed[narrowed["부품명(규격)"] == selected_part].iloc[0]
        st.caption(f"표준재고: {part_row['표준재고']}   /   현재재고: {part_row['현재재고']}")

    with st.form("purchase_request_form", clear_on_submit=True):
        requester_name = st.text_input("요청자", value=st.session_state.user_email)
        requested_qty = st.number_input("요청수량", min_value=1, step=1)
        request_note = st.text_input("요청사유 (선택)")
        submitted = st.form_submit_button("요청 등록")

        if submitted:
            if not requester_name:
                st.error("요청자를 입력해주세요.")
            else:
                material_row = narrowed[narrowed["부품명(규격)"] == selected_part].iloc[0]
                material_id = int(material_row["id"])
                open_count = db.count_open_requests_for_material(material_id)
                db.insert_purchase_request(material_id, requested_qty, requester_name, request_note)
                if open_count > 0:
                    st.warning(f"⚠️ '{selected_part}'에 이미 진행 중인 구매요청이 {open_count}건 있습니다. 그래도 새 요청을 등록했습니다 — 중복인지 확인해보세요.")
                else:
                    st.success(f"'{selected_part}' 구매요청이 등록되었습니다.")
                st.rerun()

    st.divider()
    st.subheader("구매 요청 목록")
    requests_df = db.load_purchase_requests()

    status_options = ["전체", "요청됨", "검토중", "승인됨", "구매중", "입고완료", "반려됨"]
    selected_status = st.selectbox("상태로 좁히기", status_options)
    filtered = requests_df if selected_status == "전체" else requests_df[requests_df["상태"] == selected_status]

    if filtered.empty:
        st.info("조건에 맞는 구매 요청이 없습니다.")
    else:
        display_cols = ["id", "부품명(규격)", "표준재고", "현재재고", "요청수량", "상태", "요청자", "거래업체", "단가", "입고수량", "요청일시"]
        st.dataframe(filtered[display_cols], use_container_width=True)
        excel_download_button(filtered[display_cols], "구매요청목록.xlsx", key="dl_purchase_requests")

        if st.session_state.role == "관리자":
            st.markdown("**요청 관리** (진행 중인 요청은 처리, 끝난 요청도 삭제 가능)")
            for _, r in filtered.iterrows():
                is_open = r["상태"] not in ("입고완료", "반려됨")
                c1, c2 = st.columns([5, 1])
                c1.write(f"#{r['id']}  {r['부품명(규격)']} ({r['요청수량']}개)  —  {r['상태']}")
                if c2.button("처리" if is_open else "관리", key=f"process_pr_{r['id']}", use_container_width=True):
                    purchase_request_dialog(int(r["id"]))

    st.divider()
    st.subheader("📜 구매 이력")
    st.caption("구매요청을 거쳐 입고완료된 구매가 쌓이는 기록입니다. 위 '구매 요청 목록'에서 해당 요청을 나중에 삭제해도 여기 기록은 남습니다.")
    purchase_history_df = db.load_purchase_history()
    st.dataframe(purchase_history_df, use_container_width=True)
    excel_download_button(purchase_history_df, "구매이력.xlsx", key="dl_purchase_history")

    st.divider()
    st.subheader("📜 입고 이력 (레거시)")
    st.caption("구매요청 워크플로우 도입 이전에 등록된 입고 기록입니다. 워크플로우로 처리한 최신 구매 건은 위 '구매 이력'에서 확인하세요.")
    incoming_df = history_df[history_df["구분"] == "입고"]
    incoming_df = incoming_df[~incoming_df["비고"].str.startswith("구매요청 #", na=False)]
    st.dataframe(incoming_df, use_container_width=True)
    excel_download_button(incoming_df, "입고이력.xlsx", key="dl_incoming")

# ---------- 탭 7: BOQ 검색 ----------
with tab7:
    st.subheader("BOQ 검색 (컨베이어 ID)")
    conveyor_id = st.text_input("컨베이어 ID (예: LD451 RK003)", key="boq_search")

    if conveyor_id:
        boq_df = db.get_boq(conveyor_id.strip())
        if boq_df is None:
            st.warning("해당 컨베이어 ID의 BOQ 정보를 찾을 수 없습니다.")
        else:
            st.markdown("**설계 스펙**")
            st.dataframe(boq_df, use_container_width=True)

            st.divider()
            st.markdown("**교체(사용) 이력**")
            equipment_history = db.get_equipment_history(conveyor_id.strip())
            if equipment_history.empty:
                st.info("이 설비의 교체 이력이 없습니다.")
            else:
                st.dataframe(equipment_history, use_container_width=True)
                excel_download_button(equipment_history, f"{conveyor_id.strip()}_교체이력.xlsx", key="dl_boq_history")

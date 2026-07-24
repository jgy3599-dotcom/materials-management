import io
import streamlit as st
from datetime import date
from postgrest.exceptions import APIError
from st_aggrid import AgGrid, GridOptionsBuilder
import db
import auth
import mail

# 감사 로그는 관리자보다 더 높은 권한으로, 이 계정에서만 볼 수 있게 제한합니다.
# (실제 차단은 Supabase의 RLS 정책이 하고, 이건 화면에 아예 안 보이게 하는 용도입니다.)
SUPER_ADMIN_EMAIL = "gyjeong@hanjin.com"

# AgGrid 표(필터 가능한 표)에서 쓰는 문구를 한글로 바꿔주는 사전입니다.
AGGRID_KOREAN_LOCALE = {
    "contains": "포함",
    "notContains": "포함 안 함",
    "equals": "같음",
    "notEqual": "같지 않음",
    "startsWith": "시작 문자",
    "endsWith": "끝 문자",
    "blank": "비어있음",
    "notBlank": "비어있지 않음",
    "filterOoo": "검색...",
    "applyFilter": "적용",
    "resetFilter": "초기화",
    "clearFilter": "지우기",
    "cancelFilter": "취소",
    "andCondition": "그리고",
    "orCondition": "또는",
    "loadingOoo": "불러오는 중...",
    "noRowsToShow": "표시할 데이터가 없습니다",
    "pinColumn": "컬럼 고정",
    "autosizeThiscolumn": "이 컬럼 자동맞춤",
    "autosizeAllColumns": "전체 컬럼 자동맞춤",
    "sortAscending": "오름차순 정렬",
    "sortDescending": "내림차순 정렬",
    "sortUnSort": "정렬 해제",
}


# 컬럼 제목 아래에 필터 검색창이 항상 보이는(엑셀 필터 줄과 비슷한) 표를 그려줍니다.
# 화면에서 필터/정렬한 결과를 돌려주므로, 그 결과를 그대로 엑셀 다운로드에 넘기면
# "화면에 보이는 것"과 "다운로드되는 것"이 서로 다른 문제가 생기지 않습니다.
# selectable=True로 주면 행을 하나 골라 선택할 수 있게 되고, (필터된 표, 선택된 행) 두 개를 돌려줍니다.
def filterable_table(df, key, height=500, selectable=False):
    grid_builder = GridOptionsBuilder.from_dataframe(df)
    grid_builder.configure_default_column(filter=True, sortable=True, resizable=True, floatingFilter=True)
    if selectable:
        grid_builder.configure_selection(selection_mode="single", use_checkbox=False)
    grid_options = grid_builder.build()
    grid_options["localeText"] = AGGRID_KOREAN_LOCALE
    # update_on/data_return_mode 기본값이 이미 필터·정렬·선택 변경 시 그 결과를 돌려주므로 따로 옵션을 안 줘도 됩니다.
    grid_response = AgGrid(
        df, gridOptions=grid_options, height=height, key=key,
        # 기본 상태에선 셀 안 글자를 마우스로 드래그해서 선택/복사할 수 없어서, CSS로 풀어줍니다.
        custom_css={".ag-cell": {"user-select": "text"}},
    )
    filtered_df = grid_response["data"]
    filtered_df = filtered_df if filtered_df is not None else df

    if not selectable:
        return filtered_df

    selected_rows = grid_response.get("selected_rows")
    selected_row = None
    if selected_rows is not None and len(selected_rows) > 0:
        selected_row = selected_rows.iloc[0] if hasattr(selected_rows, "iloc") else selected_rows[0]
    return filtered_df, selected_row

# 표를 엑셀 바이트로 변환합니다. 같은 내용의 표면 다시 변환하지 않고 캐시된 결과를 재사용합니다.
# (버튼을 안 눌러도 화면이 다시 그려질 때마다 이 변환이 실행되므로, 캐시가 없으면 매번 낭비됩니다.)
# ttl/max_entries를 안 주면 서버를 오래 켜둘수록(필터 조건마다 다른 내용이 계속 생기므로)
# 캐시가 끝없이 쌓여 메모리를 계속 잡아먹으므로, 오래된 것과 너무 많은 것은 정리되게 합니다.
@st.cache_data(ttl=60, max_entries=20)
def _to_excel_bytes(df):
    buffer = io.BytesIO()
    df.to_excel(buffer, index=False, engine="openpyxl")
    return buffer.getvalue()


# 사용(출고) 이력에서 설비ID 행을 골라 "BOQ 검색으로 이동" 버튼을 누르면 실행되는 콜백입니다.
# 메뉴 전환(active_tab)은 위젯이 이미 그려진 뒤에는 코드로 못 바꾸고, 버튼 콜백 안에서만 바꿀 수 있습니다.
def jump_to_boq(equipment_id):
    st.session_state["boq_search"] = equipment_id
    st.session_state["active_tab"] = "🔎 BOQ 검색"


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
            order_code = st.text_input("발주코드", value=row["order_code"] or "")
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
                    "standard_qty": standard_qty, "note": note,
                    "warehouse_no": warehouse_no or None, "order_code": order_code or None,
                }
                db.update_material(material_id, after_data)

                # 현재재고는 다른 필드처럼 그냥 덮어쓰지 않고, "이 화면 열었을 때 값 대비 얼마나 바뀌었는지"를
                # 계산해서 그 차이만큼만 더합니다. 그래야 이 폼이 열려있는 동안 출고/입고로 재고가
                # 이미 바뀌었어도, 그 변화를 덮어써서 없애버리지 않고 관리자의 수정 의도(±차이)만 반영됩니다.
                qty_delta = current_qty - int(row["current_qty"] or 0)
                if qty_delta != 0:
                    db.adjust_material_qty(material_id, qty_delta)

                db.insert_audit_log(st.session_state.user_email, "update", material_id, part, row, {**after_data, "current_qty": current_qty})
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
            st.warning(f"입고완료 상태입니다. 삭제하면 현재재고에서 {row['입고수량']}개를 다시 빼고, 구매 이력에는 취소된 것으로 표시됩니다(기록 자체는 지워지지 않고 남습니다).")
        else:
            st.caption("아직 입고 전이라 재고에는 영향이 없습니다.")
        confirm = st.checkbox("삭제하겠습니다", key=f"confirm_delete_pr_{request_id}")
        if st.button("삭제", type="primary", disabled=not confirm):
            db.delete_purchase_request(request_id)
            st.success("삭제했습니다.")
            st.rerun()

auth.check_login()

# 왼쪽 사이드바의 메뉴(라디오 버튼)로 화면을 전환합니다. key="active_tab"으로 값을 저장해두면,
# 코드에서 st.session_state["active_tab"]에 메뉴 이름을 넣는 것만으로 다른 메뉴로 전환시킬 수
# 있습니다 (사용이력 → BOQ 검색 자동 이동에 씀). 라디오 값이 바뀌면 화면이 자동으로 다시 실행되므로,
# 아래에서 각 메뉴 내용을 "if selected_page == ...:"로 감싸서 지금 선택된 메뉴만 계산하게 합니다.
PAGES = ["📋 자재 목록", "➕ 자재 등록", "🔧 사용(출고) 이력", "⚠️ 구매 필요 알림", "🛒 구매 요청", "🧰 수리 관리", "🔎 BOQ 검색"]
if "active_tab" not in st.session_state:
    st.session_state["active_tab"] = PAGES[0]

# 라디오 버튼 대신, 각 메뉴를 버튼으로 그립니다. 지금 선택된 메뉴만 type="primary"(테마 색 채움)로
# 표시해서 버튼 자체의 기본 스타일만으로도 깔끔하게 구분되도록 합니다(CSS 없이 정갈한 모양).
with st.sidebar:
    for page in PAGES:
        if st.button(
            page, key=f"nav_{page}", width="stretch",
            type="primary" if st.session_state["active_tab"] == page else "secondary",
        ):
            st.session_state["active_tab"] = page
            st.rerun()
    st.divider()

selected_page = st.session_state["active_tab"]

auth.render_sidebar()

# 화면 맨 위에 제목과 짧은 설명을 표시합니다.
st.title("📦 자재관리 시스템")
st.caption("설비 자재 재고, 입출고 이력, 구매 요청을 한 곳에서 관리합니다.")

# 자재 목록은 탭에 안 들어가도 상단 알림에 필요해서 항상 불러옵니다. 이력(history_df)은 실제로
# 쓰는 탭(사용이력/구매요청)이 열려있을 때만 불러오도록, 각 탭 안에서 필요할 때 불러옵니다.
materials_df = db.load_materials()
_materials_for_alert = db.with_구매필요(materials_df)
_need_purchase_count = int((_materials_for_alert["구매필요"] > 0).sum())

# 탭에 들어가지 않아도 전체 현황을 한눈에 볼 수 있도록, 요약 수치를 카드 형태로 한 줄에 띄워둡니다.
with st.container(horizontal=True):
    st.metric(":material/inventory_2: 전체 자재", f"{len(materials_df)}건", border=True)
    st.metric(":material/category: 카테고리", f"{materials_df['카테고리'].nunique()}개", border=True)
    st.metric(
        ":material/shopping_cart: 구매 필요", f"{_need_purchase_count}건", border=True,
        delta=f"확인 필요" if _need_purchase_count > 0 else None, delta_color="inverse",
    )

if _need_purchase_count > 0:
    st.warning(f"⚠️ 표준재고보다 부족한 자재가 **{_need_purchase_count}건** 있습니다. '⚠️ 구매 필요 알림' 탭에서 확인하세요.")

st.divider()

# ---------- 자재 목록 ----------
if selected_page == "📋 자재 목록":
    st.subheader("전체 자재 목록")
    materials = materials_df
    # AgGrid는 엑셀처럼 컬럼 제목 아래에 필터 검색창이 붙는 표 컴포넌트입니다.
    filtered_materials = filterable_table(_materials_for_alert, key="materials_grid")
    st.caption(f"총 {len(materials)}건의 자재가 등록되어 있습니다.")
    excel_download_button(filtered_materials, "자재목록.xlsx", key="dl_materials")

    st.divider()
    if st.session_state.role != "관리자":
        st.caption("✏️ 자재 수정/삭제는 관리자만 가능합니다.")
    else:
        st.markdown("**✏️ 자재 수정/삭제**")
        st.caption("카테고리나 검색어로 좁힌 뒤, 원하는 자재 옆의 ✏️ 버튼을 누르면 수정/삭제 창이 뜹니다.")

        if materials.empty:
            st.info("먼저 '자재 등록' 메뉴에서 자재를 하나 이상 등록해주세요.")
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
                filterable_table(db.load_audit_log(), key="audit_log_grid")

# ---------- 자재 등록 ----------
if selected_page == "➕ 자재 등록":
    st.subheader("새 자재 등록")
    # 기존에 등록된 카테고리 목록을 뽑아서 선택지로 만듭니다. 새 카테고리가 오타로 잘못
    # 생기는 걸 막기 위해, "직접 입력" 옵션은 관리자에게만 보여줍니다.
    NEW_CATEGORY_OPTION = "➕ 새 카테고리 직접 입력"
    existing_categories = sorted(materials_df["카테고리"].dropna().unique().tolist())
    category_options = existing_categories + [NEW_CATEGORY_OPTION] if st.session_state.role == "관리자" else existing_categories

    # 카테고리 선택은 form 밖에 둬야, 고를 때마다 바로바로 아래 "새 카테고리명" 입력칸이
    # 활성화/비활성화됩니다. (form 안에 넣으면 "등록하기"를 눌러야만 반영되기 때문입니다.)
    category_choice = st.selectbox("카테고리", category_options)

    # form()으로 감싼 입력창들은 "등록하기" 버튼을 눌러야 한번에 처리됩니다.
    with st.form("register_form", clear_on_submit=True):
        col1, col2 = st.columns(2)
        with col1:
            new_category = st.text_input(
                "새 카테고리명 (위에서 '➕ 새 카테고리 직접 입력'을 골랐을 때만 입력)",
                disabled=(category_choice != NEW_CATEGORY_OPTION),
            )
            sub_type = st.text_input("구분 (선택 입력, 예: 베어링/키/풀리)")
            part = st.text_input("부품명(규격)")
            order_code = st.text_input("발주코드 (선택 입력, 외산(TAMS)에서 사용)")
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
                new_data = {
                    "category": category, "sub_type": sub_type or None, "part_name": part, "install_location": location,
                    "manufacturer": manufacturer, "vendor": vendor, "in_use_qty": in_use_qty,
                    "standard_qty": standard_qty, "current_qty": current_qty, "note": note,
                    "warehouse_no": warehouse_no or None, "order_code": order_code or None,
                }
                new_material_id = db.insert_material(new_data)
                db.insert_audit_log(st.session_state.user_email, "insert", new_material_id, part, None, new_data)
                st.success(f"'{part}' 자재가 등록되었습니다.")
                st.rerun()

# ---------- 사용(출고) 이력 ----------
# 입고(구매) 이력은 '🛒 구매 요청' 메뉴에서 따로 관리합니다. 여기는 설비 교체 등으로
# 자재가 나간(출고) 기록만 다룹니다.
if selected_page == "🔧 사용(출고) 이력":
    history_df = db.load_history()

    st.subheader("사용(출고) 이력")
    outgoing_df = history_df[history_df["구분"] == "출고"]
    st.caption("행을 클릭해서 선택한 뒤, 아래 버튼을 누르면 그 설비ID로 'BOQ 검색' 메뉴로 이동합니다.")

    filtered_outgoing, selected_row = filterable_table(outgoing_df, key="outgoing_grid", selectable=True)

    clicked_equipment_id = selected_row.get("설비ID") if selected_row is not None and hasattr(selected_row, "get") else None
    if clicked_equipment_id:
        # 메뉴 전환은 라디오가 이미 그려진 뒤라 여기서 바로 못 바꾸고, 버튼 콜백 안에서만 바꿀 수 있습니다.
        st.button(
            f"🔎 '{clicked_equipment_id}' BOQ 검색으로 이동", key="jump_to_boq_btn",
            on_click=jump_to_boq, args=(clicked_equipment_id,),
        )

    excel_download_button(filtered_outgoing, "사용이력.xlsx", key="dl_outgoing")

    st.divider()
    st.subheader("출고 등록")
    materials = materials_df

    if materials.empty:
        st.info("먼저 '자재 등록' 메뉴에서 자재를 하나 이상 등록해주세요.")
    else:
        # 카테고리 선택은 form 밖에 둬야, 고를 때마다 바로바로 아래 부품 목록이 좁혀집니다.
        # (form 안에 넣으면 "등록하기"를 눌러야만 반영되기 때문입니다.)
        category_list = ["전체"] + sorted(materials["카테고리"].dropna().unique().tolist())
        selected_category = st.selectbox("카테고리로 먼저 좁히기", category_list)

        if selected_category == "전체":
            narrowed = materials
        else:
            narrowed = materials[materials["카테고리"] == selected_category]

        # "자재 출처"는 이 자재를 어느 소속(보우/POSCO/한진 SPARE/한진 구매품/BEUMER)에서 썼는지 기록합니다.
        MATERIAL_SOURCE_OPTIONS = ["보우", "POSCO", "한진 SPARE", "한진 구매품", "BEUMER", "직접 입력"]

        with st.form("history_form", clear_on_submit=True):
            col1, col2 = st.columns(2)
            with col1:
                selected_part = st.selectbox("부품명(규격)", narrowed["부품명(규격)"].tolist())
                move_qty = st.number_input("수량", min_value=1, step=1)
            with col2:
                move_date = st.date_input("일자", value=date.today())
                source_choice = st.selectbox("자재 출처", MATERIAL_SOURCE_OPTIONS)
                custom_source = st.text_input("직접 입력 (위에서 '직접 입력'을 골랐을 때만)")

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
                source = custom_source if source_choice == "직접 입력" else source_choice

                # history 테이블에 이번 출고 기록을 추가합니다.
                db.insert_history({
                    "occurred_on": move_date.isoformat(), "direction": "출고",
                    "material_id": material_id, "quantity": move_qty,
                    "manager": source, "note": note or None,
                    "equipment_id": equipment_id or None, "problem": problem or None,
                    "action_taken": action_taken or None, "part_memo": part_memo or None,
                })

                # 출고니까 현재재고를 줄여서 materials 테이블에도 반영합니다(자재출처와 상관없이 항상 차감).
                db.adjust_material_qty(material_id, -move_qty)

                # 한진 소유 자재(SPARE/구매품)를 썼으면, 나중에 수리돼서 돌아올 수도 있으니
                # "수리 관리"에도 자동으로 같이 등록합니다. (재고는 위에서 이미 차감했으므로 중복 차감 안 함)
                if source in ("한진 SPARE", "한진 구매품"):
                    db.insert_repair(material_id, move_qty, move_date.isoformat(), None, problem or None, None, note or None)

                st.success(f"'{selected_part}' 출고 {move_qty}건이 등록되었습니다.")
                st.rerun()

# ---------- 구매 필요 알림 ----------
if selected_page == "⚠️ 구매 필요 알림":
    st.subheader("구매가 필요한 자재")
    need_purchase = _materials_for_alert[_materials_for_alert["구매필요"] > 0].copy()
    # 부족한 정도가 큰 자재부터 위에 보이도록 정렬합니다.
    need_purchase = need_purchase.sort_values("구매필요", ascending=False)

    st.metric("구매 필요 자재 건수", f"{len(need_purchase)}건")

    category_list = ["전체"] + sorted(need_purchase["카테고리"].dropna().unique().tolist())
    selected_category = st.selectbox("카테고리로 좁히기", category_list, key="alert_category")
    if selected_category != "전체":
        need_purchase = need_purchase[need_purchase["카테고리"] == selected_category]

    filtered_need_purchase = filterable_table(need_purchase, key="need_purchase_grid")
    excel_download_button(filtered_need_purchase, "구매필요목록.xlsx", key="dl_need_purchase")

    st.divider()
    recipient_email = st.text_input("받는 사람 이메일", value=st.secrets["naver_mail"]["sender_email"])
    if st.button("📧 알림 메일 보내기"):
        if need_purchase.empty:
            st.info("현재 구매가 필요한 자재가 없어 보낼 내용이 없습니다.")
        elif not recipient_email:
            st.error("받는 사람 이메일을 입력해주세요.")
        else:
            try:
                mail.send_purchase_alert_email(need_purchase, recipient_email)
                st.success(f"{recipient_email}로 알림 메일을 보냈습니다.")
            except Exception as e:
                st.error(f"메일 발송에 실패했습니다: {e}")

# ---------- 구매 요청 ----------
if selected_page == "🛒 구매 요청":
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
        filtered_requests = filterable_table(filtered[display_cols], key="purchase_requests_grid")
        excel_download_button(filtered_requests, "구매요청목록.xlsx", key="dl_purchase_requests")

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
    filtered_purchase_history = filterable_table(purchase_history_df, key="purchase_history_grid")
    excel_download_button(filtered_purchase_history, "구매이력.xlsx", key="dl_purchase_history")

# ---------- 수리 관리 ----------
# 수리 건은 여기서 직접 새로 등록하지 않습니다. "사용(출고) 이력" 탭에서 자재출처를 "한진 SPARE"나
# "한진 구매품"으로 등록하면 자동으로 여기 생깁니다. 이 탭은 현황 확인 + 반납(복귀/폐기) 처리만 합니다.
if selected_page == "🧰 수리 관리":
    st.subheader("수리 현황")
    st.caption("자재출처를 '한진 SPARE'나 '한진 구매품'으로 사용(출고) 등록하면 자동으로 여기 등록됩니다.")
    st.caption("행을 클릭해서 선택한 뒤, 아래에서 반납(복귀/폐기)을 등록할 수 있습니다.")
    repairs_df = db.load_repairs()
    filtered_repairs, selected_repair = filterable_table(repairs_df, key="repairs_grid", selectable=True)
    excel_download_button(filtered_repairs, "수리현황.xlsx", key="dl_repairs")

    if selected_repair is not None and hasattr(selected_repair, "get"):
        repair_id = selected_repair.get("id")
        repair_material_id = selected_repair.get("material_id")
        repair_part_name = selected_repair.get("부품명(규격)")
        repair_sent_qty = selected_repair.get("보낸수량")
        repair_returned_qty = selected_repair.get("반납수량")
        if repair_id:
            st.divider()
            st.markdown(f"**'{repair_part_name}' 반납 등록** (보낸 수량 {repair_sent_qty}개 중 {repair_returned_qty}개 반납됨)")

            with st.form("repair_return_form", clear_on_submit=True):
                col1, col2 = st.columns(2)
                with col1:
                    return_qty = st.number_input("이번 반납 수량", min_value=1, step=1)
                    return_on = st.date_input("반납일", value=date.today())
                with col2:
                    return_outcome = st.selectbox("결과", ["정상복귀", "폐기"])
                return_note = st.text_input("비고", key="repair_return_note")

                return_submitted = st.form_submit_button("반납 등록")

                if return_submitted:
                    db.insert_repair_return(int(repair_id), int(repair_material_id), return_qty, return_on.isoformat(), return_outcome, return_note)
                    if return_outcome == "정상복귀":
                        st.success(f"{return_qty}개 정상복귀 처리했습니다. 현재재고에 다시 더했습니다.")
                    else:
                        st.success(f"{return_qty}개 폐기 처리했습니다. 재고는 복구하지 않았습니다.")
                    st.rerun()

            st.markdown("**반납 이력**")
            filterable_table(db.load_repair_returns(int(repair_id)), key="repair_returns_grid", height=200)

# ---------- BOQ 검색 ----------
if selected_page == "🔎 BOQ 검색":
    st.subheader("BOQ 검색 (컨베이어 ID)")
    st.caption("PLC 그룹 없는 형태(예: LM101 BD001)와 PLC 그룹 포함된 형태(예: CC101 LM101 BD001) 둘 다 검색됩니다.")
    conveyor_id = st.text_input("컨베이어 ID", key="boq_search")

    if conveyor_id:
        # BOQ 스펙이 없어도(예: 컨베이어가 아니라 제어반 등 BOQ에 애초에 없는 설비) 교체이력은
        # 있을 수 있으므로, 스펙 검색과 이력 검색을 서로 상관없이 각각 따로 진행합니다.
        st.markdown("**설계 스펙**")
        boq_df = db.get_boq(conveyor_id.strip())
        if boq_df is None:
            st.info("해당 ID의 BOQ(설계 스펙) 정보가 없습니다.")
            # 교체이력은 history.설비ID(PLC 그룹 없는 형태)로 남아있으므로, 검색어를 그대로 씁니다.
            equipment_id_for_history = conveyor_id.strip()
        else:
            filterable_table(boq_df, key="boq_spec_grid", height=120)
            # PLC 그룹 포함 형태로 검색했더라도, 교체이력은 PLC 그룹 없는 원래 컨베이어 ID로 남아있어서
            # BOQ에서 찾은 원래 컨베이어 ID를 이력 검색에 씁니다.
            equipment_id_for_history = boq_df.iloc[0]["컨베이어 ID"]

        st.divider()
        st.markdown("**교체(사용) 이력**")
        # 이미 불러온 history_df를 그대로 필터링합니다 (DB에 따로 다시 조회하지 않습니다).
        history_df = db.load_history()
        equipment_history = history_df[
            (history_df["설비ID"] == equipment_id_for_history) & (history_df["구분"] == "출고")
        ][["일자", "부품명(규격)", "수량", "자재 출처", "문제", "조치", "부품메모", "비고"]].sort_values("일자", ascending=False)
        if equipment_history.empty:
            st.info("이 설비의 교체 이력이 없습니다.")
        else:
            filtered_equipment_history = filterable_table(equipment_history, key="boq_history_grid")
            excel_download_button(filtered_equipment_history, f"{conveyor_id.strip()}_교체이력.xlsx", key="dl_boq_history")

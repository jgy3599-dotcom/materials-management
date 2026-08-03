// Supabase에서 데이터를 가져오는 함수들을 모아둡니다.
// Streamlit 앱의 db.py에 해당합니다. 업무 규칙은 DB의 SQL 함수와 RLS가 그대로 갖고 있으므로,
// 여기서는 부르기만 하고 규칙을 다시 구현하지 않습니다.
import { supabase } from "./supabase.js";

// boq 테이블의 영문 컬럼명을 화면에 보여줄 한글 이름으로 바꿔주는 매핑표입니다.
// (db.py의 BOQ_COLUMNS와 같은 내용입니다. 한쪽을 고치면 다른 쪽도 맞춰야 합니다.)
export const BOQ_LABELS = {
    conveyor_id: "컨베이어 ID",
    category_large: "대분류",
    category_mid: "중분류",
    location_1: "위치1",
    location_2: "위치2",
    equipment_type: "설비구분",
    conveyor_type: "컨베이어 종류",
    length_mm: "길이(mm)",
    width_mm: "폭(mm)",
    angle: "각도",
    belt_type: "벨트 종류",
    belt_length: "벨트 규격",
    motor_model: "모터 모델",
    motor_type: "모터 종류",
    motor_power: "모터 출력",
    reducer_ratio: "감속비",
    timing_chain: "타이밍벨트/체인",
    remarks: "비고",
    conveyor_id_with_plc: "컨베이어 ID(PLC그룹포함)",
};

// 스펙 카드 맨 위에 크게/배지로 따로 보여줄 항목입니다. 아래 목록에서는 빠집니다.
export const BOQ_TITLE_FIELD = "conveyor_id";
export const BOQ_BADGE_FIELDS = ["category_large", "equipment_type", "conveyor_type"];


// materials 테이블의 영문 컬럼명을 화면에 보여줄 한글 이름으로 바꿔주는 매핑표입니다.
// (db.py의 MATERIAL_COLUMNS와 같은 내용입니다.)
export const MATERIAL_LABELS = {
    id: "id",
    warehouse_no: "창고번호",
    category: "카테고리",
    sub_type: "구분",
    part_name: "부품명(규격)",
    order_code: "발주코드",
    install_location: "설치위치",
    manufacturer: "제조사",
    vendor: "거래처",
    in_use_qty: "적용수량",
    standard_qty: "표준재고",
    current_qty: "현재재고",
    note: "비고",
};


// 화면 맨 위 요약 카드에 쓰는 숫자 3개를 DB에서 한 번에 세어 옵니다.
// 자재 목록 전체를 받아와 세는 것보다 훨씬 빠릅니다(측정값 247ms -> 75ms).
export async function getDashboardSummary() {
    const { data, error } = await supabase.rpc("dashboard_summary");
    if (error) throw error;
    const row = (data && data[0]) || {};
    return {
        total: row.total ?? 0,
        categories: row.categories ?? 0,
        needPurchase: row.need_purchase ?? 0,
    };
}


// 자재 목록 전체를 한글 컬럼명으로 바꿔서 가져옵니다.
// Supabase는 한 번에 최대 1000건까지만 주므로, 1000건이 넘으면 나눠서 가져와야 합니다.
export async function getMaterials() {
    const PAGE = 1000;
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
            .from("materials")
            .select("*")
            .order("id")
            .range(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...data);
        if (data.length < PAGE) break;   // 마지막 페이지
    }

    return rows.map((row) => {
        const out = {};
        for (const [col, label] of Object.entries(MATERIAL_LABELS)) out[label] = row[col];
        // 구매필요는 저장된 값이 아니라 매번 계산해서 붙입니다.
        out["구매필요"] = (row.standard_qty ?? 0) - (row.current_qty ?? 0);
        return out;
    });
}


// 컨베이어 ID로 BOQ(설비 설계 사양) 한 건을 찾습니다.
// "LM101 BD001"처럼 PLC 그룹 없는 형태와 "CC101 LM101 BD001"처럼 포함된 형태 둘 다로
// 검색할 수 있고, 띄어쓰기·대소문자도 무시됩니다. 실제 비교는 DB의 find_boq 함수가 합니다.
export async function findBoq(search) {
    const { data, error } = await supabase.rpc("find_boq", { p_search: search });
    if (error) throw error;
    return data && data.length ? data[0] : null;
}


// 설비 하나의 교체(사용) 이력을 가져옵니다.
// 이력 전체를 받아와 걸러내지 않고, 그 설비 것만 DB에서 바로 뽑습니다.
export async function getEquipmentHistory(equipmentId) {
    const { data, error } = await supabase
        .from("history")
        .select("occurred_on, quantity, manager, problem, action_taken, part_memo, note, materials(part_name)")
        .eq("equipment_id", equipmentId)
        .eq("direction", "출고")
        .order("occurred_on", { ascending: false });
    if (error) throw error;

    return (data ?? []).map((row) => ({
        일자: row.occurred_on,
        "부품명(규격)": row.materials?.part_name ?? null,
        수량: row.quantity,
        "자재 출처": row.manager,
        문제: row.problem,
        조치: row.action_taken,
        부품메모: row.part_memo,
        비고: row.note,
    }));
}

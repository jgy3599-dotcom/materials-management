// Supabase에서 데이터를 가져오는 함수들을 모아둡니다.
// Streamlit 앱의 db.py에 해당합니다. 업무 규칙은 DB의 SQL 함수와 RLS가 그대로 갖고 있으므로,
// 여기서는 부르기만 하고 규칙을 다시 구현하지 않습니다.
import { supabase } from "./supabase.js";
import { today } from "./ui.js";

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


// Supabase는 한 번에 최대 1000건까지만 돌려주므로, 그보다 많으면 나눠서 가져와야 합니다.
//
// 첫 페이지를 받을 때 전체 건수도 함께 확인한 뒤, 나머지 페이지는 한꺼번에 요청합니다.
// 차례대로 기다리면 4,246건(5페이지)에서 왕복 시간이 다섯 번 쌓이는데, 동시에 보내면
// 가장 느린 하나만큼만 걸립니다. 브라우저가 동시 요청을 알아서 처리해 줍니다.
//
// buildQuery(opts)는 부를 때마다 새 질의를 만들어주는 함수이며, opts는 select의
// 두 번째 인자로 그대로 넘겨서 건수를 함께 받아오는 데 씁니다.
async function fetchAllRows(buildQuery) {
    const PAGE = 1000;

    const first = await buildQuery({ count: "exact" }).range(0, PAGE - 1);
    if (first.error) throw first.error;

    const total = first.count ?? first.data.length;
    if (total <= PAGE) return first.data;

    const pending = [];
    for (let from = PAGE; from < total; from += PAGE) {
        pending.push(buildQuery({}).range(from, from + PAGE - 1));
    }

    const rows = [...first.data];
    for (const result of await Promise.all(pending)) {
        if (result.error) throw result.error;
        rows.push(...result.data);
    }
    return rows;
}


// 자재 목록 전체를 한글 컬럼명으로 바꿔서 가져옵니다.
export async function getMaterials() {
    const rows = await fetchAllRows((opts) =>
        supabase.from("materials").select("*", opts).order("id"));

    return rows.map((row) => {
        const out = {};
        for (const [col, label] of Object.entries(MATERIAL_LABELS)) out[label] = row[col];
        // 구매필요는 저장된 값이 아니라 매번 계산해서 붙입니다.
        out["구매필요"] = (row.standard_qty ?? 0) - (row.current_qty ?? 0);
        return out;
    });
}


// 부품 선택칸을 채우는 데 필요한 컬럼만 가져옵니다.
//
// getMaterials()는 컬럼을 전부 받아오는데, 선택칸에 필요한 것은 네 개뿐입니다. 출고 화면은
// 화면을 열 때와 출고를 등록할 때마다 이걸 다시 읽으므로, 주고받는 양이 그만큼 줄어듭니다.
// (자재 목록·구매 요청·구매필요 알림 화면은 재고나 거래처 같은 나머지 컬럼도 쓰므로
//  그쪽은 계속 getMaterials()를 씁니다.)
export async function getMaterialOptions() {
    const rows = await fetchAllRows((opts) =>
        supabase.from("materials").select("id, category, part_name, warehouse_no, current_qty", opts).order("id"));

    // 이름을 MATERIAL_LABELS로 돌려 붙이지 않고 하나씩 적습니다. 그 표는 "화면에 보여줄
    // 한글 이름"이라 id만 예외로 자기 자신을 가리키는데, 나중에 누가 그 줄을 군더더기로
    // 보고 지우면 여기서 id가 조용히 사라집니다(등록할 때 자재 번호가 NaN이 됩니다).
    return rows.map((row) => ({
        id: row.id,
        "카테고리": row.category,
        "부품명(규격)": row.part_name,
        "창고번호": row.warehouse_no,
        "현재재고": row.current_qty,
    }));
}


// 카테고리 이름만 중복 없이 가져옵니다. 자재 등록 화면은 선택지를 만드는 데에만 쓰는데
// getMaterials()를 부르면 4,000행을 컬럼 전부와 함께 받게 됩니다. 여기서는 한 컬럼만
// 받으므로 주고받는 양이 훨씬 적습니다.
export async function getCategories() {
    const rows = await fetchAllRows((opts) =>
        supabase.from("materials").select("category", opts).order("category"));
    // 정렬은 JS로 한 번 더 합니다. DB 정렬 규칙에 기대지 않고 예전과 같은 순서를 유지합니다.
    return [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
}


// 자재를 새로 등록하고, 만들어진 id를 돌려줍니다.
export async function insertMaterial(data) {
    const { data: rows, error } = await supabase.from("materials").insert(data).select("id");
    if (error) throw error;
    return rows[0].id;
}


// 자재 한 건을 DB에서 새로 읽어옵니다.
// 표에 그려둔 값은 화면을 열어둔 사이에 낡을 수 있어서, 수정 팝업을 열 때는
// 표의 값을 쓰지 않고 반드시 여기서 최신 값을 받아옵니다.
export async function getMaterial(id) {
    const { data, error } = await supabase.from("materials").select("*").eq("id", id);
    if (error) throw error;
    return data && data.length ? data[0] : null;
}


export async function updateMaterial(id, data) {
    const { error } = await supabase.from("materials").update(data).eq("id", id);
    if (error) throw error;
}


export async function deleteMaterial(id) {
    const { error } = await supabase.from("materials").delete().eq("id", id);
    if (error) throw error;
}


// 현재재고를 delta만큼 더합니다(음수면 뺍니다).
// DB에 저장된 값을 직접 기준으로 더하므로, 읽어와서 계산한 뒤 덮어쓰는 방식과 달리
// 그 사이에 일어난 출고·입고를 지워버리지 않습니다.
export async function adjustMaterialQty(id, delta) {
    const { error } = await supabase.rpc("adjust_material_qty", {
        p_material_id: id,
        p_delta: delta,
    });
    if (error) throw error;
}


// 감사 로그(최근 200건)입니다. 최상위권한자만 읽을 수 있게 RLS가 막고 있습니다.
// before_data/after_data는 자재 한 행 전체가 담긴 중첩 JSON이라 표에 그대로 넣기 어려워
// 글자로 바꿔서 내보냅니다.
export async function getAuditLog() {
    const { data, error } = await supabase
        .from("audit_log")
        .select("*")
        .order("id", { ascending: false })
        .limit(200);
    if (error) throw error;

    return (data ?? []).map((row) => ({
        id: row.id,
        일시: row.occurred_at,
        작업: row.action,
        자재id: row.material_id,
        "부품명(규격)": row.part_name,
        사용자: row.actor_email,
        이전값: row.before_data ? JSON.stringify(row.before_data) : null,
        이후값: row.after_data ? JSON.stringify(row.after_data) : null,
    }));
}


// 자재를 등록/수정/삭제할 때마다 남기는 감사 로그입니다.
// actor_email은 앱이 보내는 값을 DB가 그대로 믿지 않고 실제 로그인한 사람과 같은지
// 검증하므로(RLS), 반드시 지금 로그인한 이메일을 넣어야 합니다.
export async function insertAuditLog(actorEmail, action, materialId, partName, beforeData, afterData = null) {
    const { error } = await supabase.from("audit_log").insert({
        actor_email: actorEmail,
        action,
        material_id: materialId,
        part_name: partName,
        before_data: beforeData,
        after_data: afterData,
    });
    if (error) throw error;
}


// 출고 이력 한 줄에서 '부품명(규격)'과 '부품메모'를 만듭니다.
//
// ⚠️ 2026-07 이관분 4,244건은 material_id가 비어 있어(부품명이 안 맞아 연결이 안 됨)
//    자재목록에서 이름을 가져올 수 없습니다. 그럴 때는 이력에 직접 적힌 part_memo를
//    부품명으로 씁니다. 구매이력(getPurchaseHistory)이 item_description을 쓰는 것과
//    같은 방식입니다.
//
//    그러면 부품명과 부품메모가 같은 글자가 되므로, 같을 때는 메모를 비웁니다.
//    (부품메모는 원래 부품명 외에 덧붙이는 메모 칸입니다)
//
//    사용이력 화면과 BOQ 설비이력이 이 함수를 같이 씁니다. 한쪽만 고치면 두 화면이
//    갈라지므로 반드시 여기서 함께 바꾸세요.
function historyPartName(row) {
    const partName = row.materials?.part_name ?? row.part_memo ?? null;
    return {
        "부품명(규격)": partName,
        부품메모: row.part_memo === partName ? null : row.part_memo,
    };
}


// 사용(출고) 이력을 가져옵니다.
// 입고 기록은 '구매 요청' 쪽에서 따로 관리하므로, 여기서는 출고만 DB에서 걸러서 받습니다.
export async function getUsageHistory() {
    const rows = await fetchAllRows((opts) =>
        supabase
            .from("history")
            .select(
                "id, material_id, occurred_on, quantity, manager, equipment_id, problem, action_taken, part_memo, note, materials(part_name)",
                opts,
            )
            .eq("direction", "출고")
            .order("id"));

    return rows.map((row) => ({
        id: row.id,
        material_id: row.material_id,
        일자: row.occurred_on,
        ...historyPartName(row),
        수량: row.quantity,
        "자재 출처": row.manager,
        설비ID: row.equipment_id,
        문제: row.problem,
        조치: row.action_taken,
        비고: row.note,
    }));
}


// 출고 이력 한 건을 다시 읽습니다. 팝업을 열 때 씁니다.
// 딸린 수리 건과 그 반납까지 같이 가져와, 반납이 있으면 화면에서 수정을 잠급니다.
export async function getUsage(id) {
    const { data, error } = await supabase
        .from("history")
        .select("*, materials(part_name), repairs(id, repair_returns(id))")
        .eq("id", id)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const returned = (data.repairs ?? []).some((r) => (r.repair_returns ?? []).length > 0);
    return {
        id: data.id,
        occurred_on: data.occurred_on,
        material_id: data.material_id,
        part_name: data.materials?.part_name ?? null,
        quantity: data.quantity,
        manager: data.manager,
        equipment_id: data.equipment_id,
        problem: data.problem,
        action_taken: data.action_taken,
        part_memo: data.part_memo,
        note: data.note,
        hasRepairReturn: returned,
        // 수리 건이 붙어 있는지. 저장하면 수리 관리가 어떻게 바뀌는지 미리 알려줄 때 씁니다.
        // 이관분처럼 한진 출처인데 수리 건이 없는 기록이 많아서, 출처만 보고 짐작하면 안 됩니다.
        hasRepair: (data.repairs ?? []).length > 0,
    };
}


// 출고 이력을 고칩니다. 재고와 수리 건은 DB 함수가 함께 처리합니다.
export async function updateUsage(id, v) {
    const { error } = await supabase.rpc("update_usage", {
        p_id: id,
        p_occurred_on: v.occurred_on,
        p_material_id: v.material_id,
        p_quantity: v.quantity,
        p_manager: v.manager,
        p_note: v.note,
        p_equipment_id: v.equipment_id,
        p_problem: v.problem,
        p_action_taken: v.action_taken,
        p_part_memo: v.part_memo,
    });
    if (error) throw error;
}


// 출고 이력을 지웁니다. 재고 원복과 수리 건 삭제도 DB 함수가 함께 합니다.
export async function deleteUsage(id) {
    const { error } = await supabase.rpc("delete_usage", { p_id: id });
    if (error) throw error;
}


// 사용(출고)을 등록합니다.
// 이력 기록 + (한진 소유 자재면) 재고 차감 + 수리 건 생성을 DB 함수 하나가 한 묶음으로
// 처리하므로, 중간에 실패해서 일부만 반영되는 일이 없습니다. 규칙은 DB에 있으니
// 여기서 다시 구현하지 않고 부르기만 합니다.
export async function registerUsage(params) {
    const { error } = await supabase.rpc("register_usage", {
        p_occurred_on: params.occurredOn,
        p_material_id: params.materialId,
        p_quantity: params.quantity,
        p_manager: params.manager,
        p_note: params.note || null,
        p_equipment_id: params.equipmentId || null,
        p_problem: params.problem || null,
        p_action_taken: params.actionTaken || null,
        p_part_memo: params.partMemo || null,
        p_deduct_stock: params.deductStock,
    });
    if (error) throw error;
}


// ---------------------------------------------------------------------------
// 구매 요청
// 상태 흐름: 요청됨 → 검토중 → 승인됨 → 구매중 → 입고완료
//           (검토중·승인됨 단계에서 반려됨으로 갈 수 있음)
// ---------------------------------------------------------------------------

// 아직 끝나지 않은(입고완료·반려됨이 아닌) 상태들입니다. 중복 요청 경고에 씁니다.
export const OPEN_STATUSES = ["요청됨", "검토중", "승인됨", "구매중"];
export const ALL_STATUSES = [...OPEN_STATUSES, "입고완료", "반려됨"];

const now = () => new Date().toISOString();


export async function getPurchaseRequests() {
    const rows = await fetchAllRows((opts) =>
        supabase
            .from("purchase_requests")
            .select("*, materials(part_name, standard_qty, current_qty)", opts)
            .order("id", { ascending: false }));

    return rows.map((row) => ({
        id: row.id,
        "부품명(규격)": row.materials?.part_name ?? null,
        material_id: row.material_id,
        표준재고: row.materials?.standard_qty ?? null,
        현재재고: row.materials?.current_qty ?? null,
        요청수량: row.requested_qty,
        상태: row.status,
        요청자: row.requester_email,
        요청사유: row.request_note,
        반려사유: row.reject_reason,
        거래업체: row.vendor,
        단가: row.unit_price,
        입고수량: row.received_qty,
        요청일시: row.requested_at,
    }));
}


// 같은 자재에 아직 진행 중인 요청이 몇 건 있는지 셉니다.
export async function countOpenRequests(materialId) {
    const { count, error } = await supabase
        .from("purchase_requests")
        .select("id", { count: "exact", head: true })
        .eq("material_id", materialId)
        .in("status", OPEN_STATUSES);
    if (error) throw error;
    return count ?? 0;
}


export async function insertPurchaseRequest(materialId, requestedQty, requesterEmail, requestNote) {
    const { error } = await supabase.from("purchase_requests").insert({
        material_id: materialId,
        requested_qty: requestedQty,
        requester_email: requesterEmail,
        request_note: requestNote || null,
        status: "요청됨",
    });
    if (error) throw error;
}


async function updateRequest(requestId, patch) {
    const { error } = await supabase.from("purchase_requests").update(patch).eq("id", requestId);
    if (error) throw error;
}

export const startReview = (id) => updateRequest(id, { status: "검토중", reviewed_at: now() });

// 검토 중에 실제로 필요한 수량이 다르다고 판단되면, 승인하면서 요청수량 자체를 고칩니다.
export const approveRequest = (id, qty) =>
    updateRequest(id, { status: "승인됨", approved_at: now(), requested_qty: qty });

export const rejectRequest = (id, reason) =>
    updateRequest(id, { status: "반려됨", rejected_at: now(), reject_reason: reason });

export const markPurchasing = (id, vendor, unitPrice) =>
    updateRequest(id, { status: "구매중", purchased_at: now(), vendor, unit_price: unitPrice });


// 입고 처리: 재고 증가 + 구매이력 기록 + 상태 변경이 DB 함수 하나로 묶여 있어서,
// 중간에 실패해 재고만 늘고 상태는 그대로인 어긋난 상태가 생기지 않습니다.
export async function receiveRequest(requestId, materialId, receivedQty, vendor, unitPrice) {
    const { error } = await supabase.rpc("receive_purchase_request", {
        p_request_id: requestId,
        p_material_id: materialId,
        p_received_qty: receivedQty,
        p_vendor: vendor,
        p_unit_price: unitPrice,
        p_received_on: today(),
    });
    if (error) throw error;
}


// 삭제: 이미 입고완료였다면 그때 늘린 재고를 되돌리고, 구매이력에는 취소 표시만 남깁니다
// (기록 자체는 지우지 않습니다). 이것도 DB 함수 하나가 한 묶음으로 처리합니다.
export async function removePurchaseRequest(requestId) {
    const { error } = await supabase.rpc("remove_purchase_request", { p_request_id: requestId });
    if (error) throw error;
}


// 구매 이력: 입고완료된 구매가 쌓이는 기록입니다. 구매요청을 나중에 지워도 남습니다.
export async function getPurchaseHistory() {
    const rows = await fetchAllRows((opts) =>
        supabase
            .from("purchase_history")
            .select("*, materials(part_name)", opts)
            .order("id", { ascending: false }));

    return rows.map((row) => ({
        id: row.id,
        // material_id가 없는 레거시 건(자재목록에 없는 소모품 등)은 item_description을 대신 보여줍니다.
        "부품명(규격)": row.materials?.part_name ?? row.item_description,
        수량: row.quantity,
        거래업체: row.vendor,
        단가: row.unit_price,
        입고일: row.received_on,
        구매요청ID: row.request_id,
        취소일시: row.reverted_at,
    }));
}


// ---------------------------------------------------------------------------
// 수리 관리
// 수리 건은 여기서 새로 만들지 않습니다. 사용(출고) 등록 시 자재출처가 한진 SPARE나
// 한진 구매품이면 register_usage가 자동으로 만들어 줍니다.
// ---------------------------------------------------------------------------

// 수리 목록을 반납 합계와 함께 가져옵니다.
// 상태는 저장된 값이 아니라, 보낸 수량과 반납 합계를 비교해서 그때그때 계산합니다.
export async function getRepairs() {
    const [repairs, returns] = await Promise.all([
        fetchAllRows((opts) =>
            supabase.from("repairs").select("*, materials(part_name)", opts).order("id", { ascending: false })),
        fetchAllRows((opts) =>
            supabase.from("repair_returns").select("repair_id, returned_qty", opts).order("id")),
    ]);

    const returnedBy = new Map();
    for (const r of returns) {
        returnedBy.set(r.repair_id, (returnedBy.get(r.repair_id) ?? 0) + r.returned_qty);
    }

    return repairs.map((row) => {
        const sent = row.quantity;
        const returned = returnedBy.get(row.id) ?? 0;
        const status = returned <= 0 ? "수리중" : returned < sent ? "일부 복귀" : "복귀완료";
        return {
            id: row.id,
            material_id: row.material_id,
            // material_id가 없는 건(자재목록에 없는 부품)은 item_description을 대신 보여줍니다.
            "부품명(규격)": row.materials?.part_name ?? row.item_description,
            보낸수량: sent,
            반납수량: returned,
            상태: status,
            보낸날짜: row.sent_on,
            보낸곳: row.vendor,
            사유: row.reason,
            예상복귀일: row.expected_return_date,
            비고: row.note,
        };
    });
}


// 수리 건 하나의 반납 기록(회차별)을 가져옵니다.
export async function getRepairReturns(repairId) {
    const { data, error } = await supabase
        .from("repair_returns")
        .select("id, returned_qty, returned_on, outcome, note")
        .eq("repair_id", repairId)
        .order("id");
    if (error) throw error;

    return (data ?? []).map((r) => ({
        id: r.id,
        반납수량: r.returned_qty,
        반납일: r.returned_on,
        결과: r.outcome,
        비고: r.note,
    }));
}


// 수리 반납을 등록합니다. 한 수리 건에 여러 번 나눠서 걸릴 수 있어 회차별로 쌓입니다.
// '정상복귀'인 만큼만 현재재고에 다시 더하고 '폐기'는 되돌리지 않는 규칙, 보낸 수량보다
// 많이 반납되지 않는지 검증까지 전부 DB 함수가 합니다. 어느 자재의 재고를 되돌릴지도
// DB가 수리 건에서 직접 찾으므로 자재 id를 넘기지 않습니다.
export async function addRepairReturn(repairId, returnedQty, returnedOn, outcome, note) {
    const { error } = await supabase.rpc("add_repair_return", {
        p_repair_id: repairId,
        p_returned_qty: returnedQty,
        p_returned_on: returnedOn,
        p_outcome: outcome,
        p_note: note || null,
    });
    if (error) throw error;
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
        ...historyPartName(row),
        수량: row.quantity,
        "자재 출처": row.manager,
        문제: row.problem,
        조치: row.action_taken,
        비고: row.note,
    }));
}

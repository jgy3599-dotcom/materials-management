// 구매 요청 화면입니다. 요청 등록 + 목록 + 단계별 처리 + 구매 이력을 다룹니다.
//
// 상태 흐름: 요청됨 → 검토중 → 승인됨 → 구매중 → 입고완료
//           (검토중·승인됨 단계에서 반려됨으로 갈 수 있음)
import {
    getMaterials, getPurchaseRequests, getPurchaseHistory, countOpenRequests,
    insertPurchaseRequest, startReview, approveRequest, rejectRequest,
    markPurchasing, receiveRequest, removePurchaseRequest, ALL_STATUSES, OPEN_STATUSES,
} from "../db.js";
import { renderTable, downloadTableExcel } from "../table.js";
import { setStatus, describeError, esc, hasValue } from "../ui.js";

const REQUEST_COLUMNS = ["id", "부품명(규격)", "표준재고", "현재재고", "요청수량", "상태",
                         "요청자", "거래업체", "단가", "입고수량", "요청일시"];
const HISTORY_COLUMNS = ["id", "부품명(규격)", "수량", "거래업체", "단가", "입고일", "구매요청ID", "취소일시"];

const REQ_TABLE = "purchase-requests-table";
const HIST_TABLE = "purchase-history-table";

let materials = [];
let requests = [];
let loaded = false;
let isAdmin = false;
let currentEmail = "";
let openRequest = null;   // 지금 팝업에 열려 있는 요청


function fillCategoryOptions() {
    const categories = [...new Set(materials.map((m) => m["카테고리"]).filter(Boolean))].sort();
    document.getElementById("pr-category").innerHTML =
        ["전체", ...categories].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
}


// 부품 선택칸을 채웁니다. 값은 부품명이 아니라 자재 id를 씁니다
// (같은 이름의 자재가 여럿이라 이름으로 되찾으면 엉뚱한 자재가 골라집니다).
function fillPartOptions() {
    const category = document.getElementById("pr-category").value;
    const select = document.getElementById("pr-part");
    const list = category === "전체" ? materials : materials.filter((m) => m["카테고리"] === category);

    select.innerHTML = list.map((m) => {
        const warehouse = m["창고번호"] ? ` · 창고 ${m["창고번호"]}` : "";
        return `<option value="${m.id}">${esc(m["부품명(규격)"])}${esc(warehouse)}</option>`;
    }).join("");

    showSelectedStock();
}


// 고른 부품의 표준재고 / 현재재고를 보여줍니다.
function showSelectedStock() {
    const id = Number(document.getElementById("pr-part").value);
    const m = materials.find((x) => x.id === id);
    document.getElementById("pr-stock").textContent = m
        ? `표준재고: ${m["표준재고"] ?? "-"}   /   현재재고: ${m["현재재고"] ?? "-"}`
        : "";
}


function applyStatusFilter() {
    const status = document.getElementById("pr-status-filter").value;
    const rows = status === "전체" ? requests : requests.filter((r) => r["상태"] === status);
    renderTable(REQ_TABLE, rows, REQUEST_COLUMNS, {
        selectable: isAdmin,
        onRowClick: isAdmin ? (row) => openDialog(row.id) : null,
    });
    document.getElementById("pr-count").textContent = `${rows.length}건`;
}


export async function load(force = false) {
    if (loaded && !force) return;

    setStatus("pr-status", "불러오는 중...");
    try {
        const [mats, reqs, hist] = await Promise.all([
            getMaterials(), getPurchaseRequests(), getPurchaseHistory(),
        ]);
        materials = mats;
        requests = reqs;

        fillCategoryOptions();
        fillPartOptions();
        applyStatusFilter();
        renderTable(HIST_TABLE, hist, HISTORY_COLUMNS);

        setStatus("pr-status", "");
        loaded = true;
    } catch (err) {
        setStatus("pr-status", describeError(err, "구매 요청을 불러오지 못했습니다."), "error");
    }
}


// ---------------------------------------------------------------------------
// 요청 처리 팝업 - 상태에 따라 보여주는 버튼과 입력칸이 달라집니다
// ---------------------------------------------------------------------------

function openDialog(requestId) {
    openRequest = requests.find((r) => r.id === requestId);
    if (!openRequest) return;

    const r = openRequest;
    document.getElementById("pr-dialog-info").innerHTML = `
        <p style="margin:0 0 4px"><strong>${esc(r["부품명(규격)"])}</strong> (요청수량: ${esc(r["요청수량"])})</p>
        <p class="caption" style="margin:0">표준재고: ${esc(r["표준재고"])} / 현재재고: ${esc(r["현재재고"])}</p>
        <p class="caption" style="margin:0">요청자: ${esc(r["요청자"])}</p>
        ${hasValue(r["요청사유"]) ? `<p class="caption" style="margin:0">요청사유: ${esc(r["요청사유"])}</p>` : ""}
        <p style="margin:8px 0 0">현재 상태: <strong>${esc(r["상태"])}</strong></p>`;

    // 상태에 맞는 칸만 보여줍니다.
    for (const step of ["요청됨", "검토중", "승인됨", "구매중", "끝"]) {
        const el = document.getElementById(`pr-step-${step}`);
        if (el) el.classList.add("hidden");
    }
    const stepId = OPEN_STATUSES.includes(r["상태"]) ? r["상태"] : "끝";
    document.getElementById(`pr-step-${stepId}`)?.classList.remove("hidden");

    // 단계별 기본값
    document.getElementById("pr-approve-qty").value = r["요청수량"];
    document.getElementById("pr-receive-qty").value = r["요청수량"];
    document.getElementById("pr-reject-reason").value = "";
    document.getElementById("pr-vendor").value = "";
    document.getElementById("pr-price").value = 0;
    document.getElementById("pr-delete-confirm").checked = false;
    document.getElementById("pr-delete-btn").disabled = true;

    document.getElementById("pr-delete-warning").textContent =
        r["상태"] === "입고완료"
            ? `입고완료 상태입니다. 삭제하면 현재재고에서 ${r["입고수량"]}개를 다시 빼고, 구매 이력에는 취소된 것으로 표시됩니다(기록 자체는 남습니다).`
            : "아직 입고 전이라 재고에는 영향이 없습니다.";

    setStatus("pr-dialog-status", "");
    document.getElementById("pr-dialog").showModal();
}


// 팝업 안에서 무언가를 처리하고, 성공하면 목록을 새로 읽어옵니다.
async function runAction(button, action, failMessage) {
    button.disabled = true;
    setStatus("pr-dialog-status", "");
    try {
        await action();
        document.getElementById("pr-dialog").close();
        await load(true);
    } catch (err) {
        setStatus("pr-dialog-status", describeError(err, failMessage), "error");
    } finally {
        button.disabled = false;
    }
}


async function submitRequest(e) {
    e.preventDefault();
    const materialId = Number(document.getElementById("pr-part").value);
    if (!materialId) {
        setStatus("pr-form-status", "부품을 선택해주세요.", "error");
        return;
    }
    const requester = document.getElementById("pr-requester").value.trim();
    if (!requester) {
        setStatus("pr-form-status", "요청자를 입력해주세요.", "error");
        return;
    }

    const btn = document.getElementById("pr-submit-btn");
    btn.disabled = true;
    try {
        // 중복 요청 경고에 쓸 건수는 등록 전에 세어둡니다(등록하면 1건 늘어나므로).
        const openCount = await countOpenRequests(materialId);
        await insertPurchaseRequest(
            materialId,
            Number(document.getElementById("pr-qty").value),
            requester,
            document.getElementById("pr-note").value.trim(),
        );

        const partName = document.getElementById("pr-part").selectedOptions[0]?.textContent ?? "";
        setStatus("pr-form-status",
            openCount > 0
                ? `⚠️ '${partName}'에 이미 진행 중인 구매요청이 ${openCount}건 있습니다. 그래도 새 요청을 등록했습니다 — 중복인지 확인해보세요.`
                : `'${partName}' 구매요청이 등록되었습니다.`,
            openCount > 0 ? "error" : "ok");

        document.getElementById("pr-note").value = "";
        await load(true);
    } catch (err) {
        setStatus("pr-form-status", describeError(err, "구매요청 등록에 실패했습니다."), "error");
    } finally {
        btn.disabled = false;
    }
}


export function init() {
    document.getElementById("pr-category").addEventListener("change", fillPartOptions);
    document.getElementById("pr-part").addEventListener("change", showSelectedStock);
    document.getElementById("pr-form").addEventListener("submit", submitRequest);
    document.getElementById("pr-status-filter").addEventListener("change", applyStatusFilter);
    document.getElementById("pr-reload-btn").addEventListener("click", () => load(true));

    document.getElementById("pr-excel-btn").addEventListener("click", () =>
        downloadTableExcel(REQ_TABLE, REQUEST_COLUMNS, "구매요청목록.xlsx"));
    document.getElementById("pr-hist-excel-btn").addEventListener("click", () =>
        downloadTableExcel(HIST_TABLE, HISTORY_COLUMNS, "구매이력.xlsx"));

    document.getElementById("pr-status-filter").innerHTML =
        ["전체", ...ALL_STATUSES].map((s) => `<option value="${s}">${s}</option>`).join("");

    // ---- 팝업 안의 단계별 버튼 ----
    document.getElementById("pr-dialog-close").addEventListener("click", () =>
        document.getElementById("pr-dialog").close());

    document.getElementById("pr-review-btn").addEventListener("click", (e) =>
        runAction(e.currentTarget, () => startReview(openRequest.id), "검토 시작 처리에 실패했습니다."));

    document.getElementById("pr-approve-btn").addEventListener("click", (e) =>
        runAction(e.currentTarget,
            () => approveRequest(openRequest.id, Number(document.getElementById("pr-approve-qty").value)),
            "승인 처리에 실패했습니다."));

    document.getElementById("pr-reject-btn").addEventListener("click", (e) => {
        const reason = document.getElementById("pr-reject-reason").value.trim();
        if (!reason) {
            setStatus("pr-dialog-status", "반려 사유를 입력해주세요.", "error");
            return;
        }
        runAction(e.currentTarget, () => rejectRequest(openRequest.id, reason), "반려 처리에 실패했습니다.");
    });

    document.getElementById("pr-purchase-btn").addEventListener("click", (e) => {
        const vendor = document.getElementById("pr-vendor").value.trim();
        if (!vendor) {
            setStatus("pr-dialog-status", "거래업체를 입력해주세요.", "error");
            return;
        }
        runAction(e.currentTarget,
            () => markPurchasing(openRequest.id, vendor, Number(document.getElementById("pr-price").value)),
            "구매 처리에 실패했습니다.");
    });

    document.getElementById("pr-receive-btn").addEventListener("click", (e) =>
        runAction(e.currentTarget,
            () => receiveRequest(
                openRequest.id, openRequest.material_id,
                Number(document.getElementById("pr-receive-qty").value),
                openRequest["거래업체"], openRequest["단가"]),
            "입고 처리에 실패했습니다."));

    document.getElementById("pr-delete-confirm").addEventListener("change", (e) => {
        document.getElementById("pr-delete-btn").disabled = !e.target.checked;
    });

    document.getElementById("pr-delete-btn").addEventListener("click", (e) =>
        runAction(e.currentTarget, () => removePurchaseRequest(openRequest.id),
            "구매요청 삭제에 실패했습니다."));
}


// 로그인한 사람의 권한에 따라 화면을 조정합니다.
export function setUser(session, admin) {
    isAdmin = admin;
    currentEmail = session?.user?.email ?? "";
    document.getElementById("pr-requester").value = currentEmail;
    document.getElementById("pr-admin-hint").classList.toggle("hidden", isAdmin);
}

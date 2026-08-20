// 구매 요청 화면입니다. 요청 등록 + 목록 + 단계별 처리 + 구매 이력을 다룹니다.
//
// 상태 흐름: 요청됨 → 검토중 → 승인됨 → 구매중 → 입고완료
//           (검토중·승인됨 단계에서 반려됨으로 갈 수 있음)
import {
    getMaterials, getMaterial, getPurchaseRequests, getPurchaseHistory, countOpenRequests,
    insertPurchaseRequest, startReview, approveRequest, rejectRequest,
    markPurchasing, receiveRequest, removePurchaseRequest, ALL_STATUSES, OPEN_STATUSES,
} from "../db.js";
import { renderTable, downloadTableExcel } from "../table.js";
import { setStatus, describeError, esc, hasValue, refill } from "../ui.js";
import { dataChanged } from "../refresh.js";

const REQUEST_COLUMNS = ["id", "부품명(규격)", "표준재고", "현재재고", "요청수량", "상태",
                         "요청자", "거래업체", "단가", "입고수량", "요청일시"];
const HISTORY_COLUMNS = ["id", "부품명(규격)", "수량", "거래업체", "단가", "입고일", "구매요청ID", "취소일시"];

const REQ_TABLE = "purchase-requests-table";
const HIST_TABLE = "purchase-history-table";

let materials = [];
let requests = [];
let loaded = false;
let loadSeq = 0;          // 불러오기 순번 (늦게 시작한 것만 화면에 그리려고)
let isAdmin = false;
let currentEmail = "";
let openRequest = null;   // 지금 팝업에 열려 있는 요청
let busy = false;         // 팝업의 처리가 DB 응답을 기다리는 중인지


// 팝업 안에서 무언가를 하는 버튼 전부입니다. 하나가 DB 응답을 기다리는 동안
// 나머지도 같이 잠가야 합니다. 닫기만 잠그면 삭제를 기다리는 사이에 입고 처리를
// 누를 수 있고, 삭제가 먼저 끝나 팝업이 닫히면 뒤늦게 온 입고 실패 메시지가
// 이미 닫힌 팝업 안에 쓰여 아무 데도 안 보입니다.
//
// "삭제하겠습니다" 체크박스도 함께 잠급니다. 안 잠그면 처리 중에 눌렀을 때 체크 표시만
// 바뀌고 삭제 버튼은 회색 그대로라, 사용자는 "체크했는데 왜 안 풀리지"를 겪습니다.
const DIALOG_BUTTONS = [
    "pr-review-btn", "pr-approve-btn", "pr-reject-btn",
    "pr-purchase-btn", "pr-receive-btn", "pr-delete-btn", "pr-dialog-close",
    "pr-delete-confirm",
];


function setBusy(on) {
    busy = on;
    for (const id of DIALOG_BUTTONS) {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = on;
    }
    // 삭제는 "삭제하겠습니다"에 체크가 되어 있을 때만 다시 풉니다.
    // 그냥 풀면 확인 절차를 건너뛰고 지울 수 있게 됩니다.
    if (!on) {
        document.getElementById("pr-delete-btn").disabled =
            !document.getElementById("pr-delete-confirm").checked;
    }
}


function fillCategoryOptions() {
    const categories = [...new Set(materials.map((m) => m["카테고리"]).filter(Boolean))].sort();
    refill(document.getElementById("pr-category"),
        ["전체", ...categories].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(""));
}


// 부품 선택칸을 채웁니다. 값은 부품명이 아니라 자재 id를 씁니다
// (같은 이름의 자재가 여럿이라 이름으로 되찾으면 엉뚱한 자재가 골라집니다).
function fillPartOptions() {
    const category = document.getElementById("pr-category").value;
    const select = document.getElementById("pr-part");
    const list = category === "전체" ? materials : materials.filter((m) => m["카테고리"] === category);

    // 맨 위에 빈 항목을 둡니다. 선택칸을 다시 그리면 브라우저가 첫 항목을 자동으로 고르는데,
    // 그게 실제 자재이면 사람이 고른 적 없는 부품으로 구매요청이 올라갑니다. 빈 항목이 첫
    // 자리에 있으면 값이 비고, submitRequest()의 "부품을 선택해주세요" 검사에 걸립니다.
    // (출고 화면 usage.js의 fillPartOptions와 같은 처리입니다)
    refill(select, [`<option value="">부품을 선택하세요</option>`, ...list.map((m) => {
        const warehouse = m["창고번호"] ? ` · 창고 ${m["창고번호"]}` : "";
        return `<option value="${m.id}">${esc(m["부품명(규격)"])}${esc(warehouse)}</option>`;
    })].join(""));

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


// 성공하면 null, 실패하면 그 사유를 돌려줍니다. 새로고침이 실패했는데 그 위에
// "삭제했습니다"를 덮어쓰면, 방금 지운 요청이 표에 그대로 남은 채 성공으로 보입니다.
export async function load(force = false) {
    if (loaded && !force) return null;

    // 순번을 매겨 두고, 나보다 나중에 시작한 것이 있으면 그리지 않고 물러납니다.
    // 특히 사람이 바뀌면 setUser가 이 번호를 올려서, 앞사람 때 시작한 불러오기가
    // 뒤늦게 끝나며 방금 비운 선택칸을 도로 채우고 "이미 읽었음"으로 표시하는 것을
    // 막습니다(그렇게 되면 뒷사람이 열어도 다시 안 읽습니다).
    const seq = ++loadSeq;

    setStatus("pr-status", "불러오는 중...");
    try {
        const [mats, reqs, hist] = await Promise.all([
            getMaterials(), getPurchaseRequests(), getPurchaseHistory(),
        ]);
        if (seq !== loadSeq) return null;
        materials = mats;
        requests = reqs;

        fillCategoryOptions();
        fillPartOptions();
        applyStatusFilter();
        renderTable(HIST_TABLE, hist, HISTORY_COLUMNS);

        setStatus("pr-status", "");
        loaded = true;
    } catch (err) {
        const reason = describeError(err, "구매 요청을 불러오지 못했습니다.");
        // 나보다 나중에 시작한 불러오기가 있으면 화면은 그쪽에 맡기고, 실패했다는 사실만
        // 돌려줍니다. 여기서 null(=성공)을 돌려주면 부른 쪽이 "다만:" 없이 초록 성공으로
        // 표시해, 새로고침이 실패했는데도 다 된 것처럼 보입니다.
        if (seq !== loadSeq) return reason;
        setStatus("pr-status", reason, "error");
        // 다시 읽기에 실패했으면 "이미 읽었다"는 표시를 지웁니다. 안 그러면 메뉴를
        // 오갔다 돌아와도 낡은 표를 그대로 둡니다.
        loaded = false;
        return reason;
    }
    return null;
}


// 재고나 자재가 바뀌었을 때 main.js가 불러줍니다. 여기서는 "다시 읽어라"고 표시만
// 하고, 실제로 읽는 것은 사용자가 이 화면을 열 때입니다.
export function invalidate() {
    loaded = false;
    loadSeq++;   // 돌고 있던 불러오기가 loaded를 도로 켜지 못하게 무효로 만듭니다
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
async function runAction(action, okMessage, failMessage) {
    // 처리가 오가는 사이 자동 로그아웃되고 다음 사람이 들어올 수 있습니다. 그때 아래
    // 안내를 그대로 쓰면 뒷사람 화면에 "입고 처리했습니다"가 뜹니다.
    const myUserKey = lastUserKey;
    setBusy(true);
    // 팝업이 통째로 잠기므로 왜 안 눌리는지 알려줍니다. 응답이 느릴 때 아무 문구도
    // 없으면 닫을 수 없는 팝업으로 보입니다.
    setStatus("pr-dialog-status", "처리 중...");
    try {
        await action();
    } catch (err) {
        setBusy(false);
        setStatus("pr-dialog-status", describeError(err, failMessage), "error");
        return;
    }

    // 다른 화면이 들고 있는 내용을 낡은 것으로 표시합니다. 입고 처리는 재고를 늘리고,
    // 나머지 단계 이동도 요청 목록을 바꿉니다. 아래의 load(true)가 이 화면의 표시는
    // 도로 켜줍니다.
    dataChanged();

    setBusy(false);
    document.getElementById("pr-dialog").close();
    const reloadError = await load(true);

    // 사람이 바뀌었으면 이 안내는 지금 화면을 보는 사람의 것이 아닙니다(위 주석 참고).
    if (lastUserKey !== myUserKey) return;

    // ⚠️ 성공했으면 반드시 성공했다고 말해야 합니다. 목록 새로고침이 실패하면 화면에는
    // 빨간 오류만 남고 행도 예전 상태 그대로여서, 관리자가 "안 됐구나" 하고 같은 처리를
    // 다시 누릅니다. 입고 처리는 두 번 하면 재고가 두 배로 들어갑니다.
    setStatus("pr-status",
        reloadError ? `${okMessage}\n\n다만: ${reloadError}` : okMessage,
        reloadError ? "error" : "ok");
}


// 자재 하나의 현재재고를 읽습니다. 못 읽으면 null입니다(안내를 생략할 뿐 막지 않습니다).
async function readStock(materialId) {
    if (!materialId) return null;
    try {
        return (await getMaterial(materialId))?.current_qty ?? null;
    } catch {
        return null;
    }
}


// 구매요청 삭제입니다. 다른 단계들과 달리 runAction을 쓰지 않는 이유는, 입고완료였던
// 요청을 지우면 그때 늘렸던 재고를 도로 빼기 때문입니다. 그 결과가 음수가 될 수 있어
// 삭제한 뒤에 확인이 필요합니다(음수를 막지는 않습니다 — 실제로 음수인 자재가 있습니다).
async function deleteRequest() {
    // 응답을 기다리는 사이 팝업이 다른 요청으로 바뀔 수 있어 지금 것을 붙잡아 둡니다.
    const request = openRequest;
    if (!request) return;
    // 사람이 바뀌는 경우도 붙잡아 둡니다(runAction과 같은 이유).
    const myUserKey = lastUserKey;

    setBusy(true);
    setStatus("pr-dialog-status", "처리 중...");

    // ⚠️ 재고를 되돌리는지는 "화면에 보이는 상태"로 판단하면 안 됩니다. DB는
    // status='입고완료' 이면서 received_qty > 0 일 때만 되돌리고, 내가 목록을 읽은 뒤
    // 다른 사람이 입고를 끝냈다면 내 화면의 상태는 아직 '구매중'입니다.
    // 그래서 상태를 보지 않고, 지우기 전후의 재고를 직접 비교합니다.
    const beforeStock = await readStock(request.material_id);

    try {
        await removePurchaseRequest(request.id);
    } catch (err) {
        setStatus("pr-dialog-status", describeError(err, "구매요청 삭제에 실패했습니다."), "error");
        setBusy(false);
        return;
    }

    dataChanged();   // 입고완료였던 요청을 지우면 재고가 도로 줄어듭니다

    // ⚠️ 재고는 지운 직후에 바로 읽습니다. 목록 새로고침(자재·요청·이력을 수천 건
    // 받아옴) 뒤에 읽으면 그 몇 초 사이 다른 사람의 출고·입고 한 건만으로도 값이
    // 달라져서, 재고를 건드리지도 않은 '반려됨' 요청을 지웠는데 경고가 뜹니다.
    const afterStock = await readStock(request.material_id);

    setBusy(false);
    document.getElementById("pr-dialog").close();
    const reloadError = await load(true);

    // 사람이 바뀌었으면 여기서 그만둡니다. 삭제 자체는 이미 끝났고, 아래에서 표를 손보고
    // 안내를 쓰는 것은 지금 화면을 보는 사람의 것이 아닙니다 — 특히 아래 filter는 뒷사람이
    // 방금 읽어온 표에서 행 하나를 지웁니다.
    if (lastUserKey !== myUserKey) return;

    if (reloadError) {
        // 목록을 못 읽었으면 방금 지운 요청만이라도 표에서 뺍니다. 그대로 두면 같은
        // 행을 또 지울 수 있는데, DB는 없는 요청도 조용히 넘어가서 "삭제했습니다"가
        // 한 번 더 뜨고 행은 여전히 사라지지 않습니다.
        requests = requests.filter((r) => r.id !== request.id);
        applyStatusFilter();
    }

    const notes = [];
    if (reloadError) notes.push(reloadError);
    // 지운 뒤 재고가 음수면 알립니다. 다만 "이번 삭제 때문인지"는 삭제 전 재고를
    // 읽었을 때만 알 수 있습니다.
    if (afterStock !== null && afterStock < 0) {
        const name = request["부품명(규격)"];
        if (beforeStock === null) {
            // 삭제 전 재고를 못 읽었습니다(통신 오류 등). 원래 음수였는지 이번에
            // 음수가 됐는지 구분할 수 없으니, 단정하지 말고 현재 값만 알립니다.
            notes.push(`'${name}'의 현재재고가 ${afterStock}개입니다. 삭제 전 재고를 읽지 못해 이번 삭제 때문인지는 알 수 없습니다. 재고나 이력을 확인해보세요.`);
        } else if (afterStock !== beforeStock) {
            // 재고가 실제로 바뀌었습니다. 원래부터 음수이던 자재를 지웠다고
            // 매번 경고하지는 않으므로, 값이 달라졌을 때만 말합니다.
            notes.push(`'${name}'의 현재재고가 ${afterStock}개입니다. 입고분을 되돌리면서 음수가 되었습니다. 재고나 이력을 확인해보세요.`);
        }
    }

    // 성공한 삭제를 빨간 실패 상자로 보여주면 안 됩니다. 새로고침이 실패했을 때만
    // 빨간색이고, 재고 안내만 있으면 노란색입니다.
    setStatus("pr-status",
        notes.length ? `구매요청을 삭제했습니다.\n\n다만: ${notes.join("\n다만: ")}` : "구매요청을 삭제했습니다.",
        reloadError ? "error" : notes.length ? "warn" : "ok");
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

    // 부품명과 지금 사람을 보내기 "전에" 붙잡아 둡니다(register.js의 submit과 같은 이유).
    // 응답을 기다리는 사이 로그아웃되고 다음 사람이 다른 부품을 고르면, 아래에서 선택칸을
    // 그때 읽는 바람에 그 사람이 고른 부품 이름으로 "등록되었습니다"가 뜹니다.
    const partName = document.getElementById("pr-part").selectedOptions[0]?.textContent ?? "";
    const myUserKey = lastUserKey;
    // ⚠️ DB에 들어가는 수량·요청사유도 반드시 여기서 읽어야 합니다. 아래 countOpenRequests를
    // 기다리는 사이 사람이 바뀌면 setUser가 폼을 비우는데, 그때 칸에서 읽으면 비워진 값
    // (수량 1, 사유 없음)이 그대로 등록됩니다. 안내까지 막히므로 아무도 모르게 잘못된
    // 요청이 한 건 쌓입니다.
    const qty = Number(document.getElementById("pr-qty").value);
    const note = document.getElementById("pr-note").value.trim();

    const btn = document.getElementById("pr-submit-btn");
    btn.disabled = true;
    try {
        // 중복 요청 경고에 쓸 건수는 등록 전에 세어둡니다(등록하면 1건 늘어나므로).
        const openCount = await countOpenRequests(materialId);
        await insertPurchaseRequest(materialId, qty, requester, note);
        dataChanged();   // 요청 목록이 바뀌었습니다(재고는 아직 그대로입니다)

        // 그 사이 사람이 바뀌었으면 여기서 그만둡니다. 등록 자체는 이미 끝났고, 아래의
        // 안내와 요청사유 지우기는 지금 화면을 보고 있는 사람의 것이 아닙니다.
        if (lastUserKey !== myUserKey) return;

        // 등록은 성공했으므로 빨간 실패 상자를 쓰지 않습니다. 실패한 줄 알고 한 번 더
        // 누르면 중복 요청이 하나 더 쌓입니다 — 중복을 알리려다 중복을 만드는 셈입니다.
        setStatus("pr-form-status",
            openCount > 0
                ? `⚠️ '${partName}'에 이미 진행 중인 구매요청이 ${openCount}건 있습니다. 그래도 새 요청을 등록했습니다 — 중복인지 확인해보세요.`
                : `'${partName}' 구매요청이 등록되었습니다.`,
            openCount > 0 ? "warn" : "ok");

        document.getElementById("pr-note").value = "";
        await load(true);
    } catch (err) {
        // 성공 경로와 같은 이유로, 사람이 바뀌었으면 이 실패 안내도 뒷사람 화면에
        // 띄우지 않습니다.
        if (lastUserKey !== myUserKey) return;
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
    document.getElementById("pr-dialog-close").addEventListener("click", () => {
        if (!busy) document.getElementById("pr-dialog").close();
    });
    // Esc 키도 같은 이유로 막습니다. ✕ 버튼만 잠그면 Esc로 빠져나갈 수 있습니다.
    document.getElementById("pr-dialog").addEventListener("cancel", (e) => {
        if (busy) e.preventDefault();
    });

    document.getElementById("pr-review-btn").addEventListener("click", () =>
        runAction(() => startReview(openRequest.id),
            "검토를 시작했습니다.", "검토 시작 처리에 실패했습니다."));

    document.getElementById("pr-approve-btn").addEventListener("click", () => {
        // 이 칸들은 <form> 밖이라 HTML의 min="1"이 전혀 작동하지 않습니다. 칸을 비우면
        // Number("")가 0이 되어 요청수량이 0으로 덮어써지므로 여기서 직접 검사합니다.
        const qty = Number(document.getElementById("pr-approve-qty").value);
        if (!Number.isInteger(qty) || qty < 1) {
            setStatus("pr-dialog-status", "승인 수량은 1개 이상의 숫자로 입력해주세요.", "error");
            return;
        }
        runAction(() => approveRequest(openRequest.id, qty),
            "요청을 승인했습니다.", "승인 처리에 실패했습니다.");
    });

    document.getElementById("pr-reject-btn").addEventListener("click", () => {
        const reason = document.getElementById("pr-reject-reason").value.trim();
        if (!reason) {
            setStatus("pr-dialog-status", "반려 사유를 입력해주세요.", "error");
            return;
        }
        runAction(() => rejectRequest(openRequest.id, reason),
            "요청을 반려했습니다.", "반려 처리에 실패했습니다.");
    });

    document.getElementById("pr-purchase-btn").addEventListener("click", () => {
        const vendor = document.getElementById("pr-vendor").value.trim();
        if (!vendor) {
            setStatus("pr-dialog-status", "거래업체를 입력해주세요.", "error");
            return;
        }
        runAction(
            () => markPurchasing(openRequest.id, vendor, Number(document.getElementById("pr-price").value)),
            "구매 처리했습니다(발주 완료).", "구매 처리에 실패했습니다.");
    });

    document.getElementById("pr-receive-btn").addEventListener("click", () => {
        // 비워두면 0이 넘어가서, 상태만 '입고완료'가 되고 재고는 그대로인 요청이 남습니다.
        // 그런 건 나중에 삭제해도 되돌릴 게 없습니다(DB가 received_qty > 0일 때만 원복).
        const qty = Number(document.getElementById("pr-receive-qty").value);
        if (!Number.isInteger(qty) || qty < 1) {
            setStatus("pr-dialog-status", "입고 수량은 1개 이상의 숫자로 입력해주세요.", "error");
            return;
        }
        runAction(
            () => receiveRequest(
                openRequest.id, openRequest.material_id, qty,
                openRequest["거래업체"], openRequest["단가"]),
            "입고 처리했습니다. 재고에 반영되었으니 다시 누르지 마세요.",
            "입고 처리에 실패했습니다.");
    });

    document.getElementById("pr-delete-confirm").addEventListener("change", (e) => {
        // 처리 중에는 손대지 않습니다. 여기서 풀어주면 setBusy가 잠가둔 삭제 버튼이
        // 체크 한 번으로 되살아나서, 잠금을 만든 의미가 없어집니다.
        // (처리가 끝나면 setBusy(false)가 체크 상태를 보고 다시 정합니다.)
        if (busy) return;
        document.getElementById("pr-delete-btn").disabled = !e.target.checked;
    });

    document.getElementById("pr-delete-btn").addEventListener("click", () => deleteRequest());
}


let lastUserKey = null;

// 로그인한 사람의 권한에 따라 화면을 조정합니다.
export function setUser(session, admin) {
    isAdmin = admin;
    currentEmail = session?.user?.email ?? "";

    // ⚠️ 사람이 바뀌면 "이미 읽었다"는 표시를 지워 표를 다시 그리게 합니다. 안 지우면
    // load()가 그냥 빠져나가서, 관리자가 로그아웃하고 공용 계정으로 로그인한 뒤에도
    // 표가 관리자 때 그려진 상태(행 클릭으로 처리 팝업이 열리는 상태)로 남습니다.
    // 그러면 일반 사용자가 승인·반려·삭제를 눌러 날것의 DB 권한 오류를 보게 됩니다.
    //
    // 폼도 같이 비웁니다. 공용 계정이라 앞사람이 골라둔 부품이 그대로 남으면, 뒷사람이
    // 수량만 바꿔 누르는 순간 엉뚱한 자재로 구매요청이 올라갑니다.
    //
    // 이 함수는 로그인이 자동으로 갱신될 때도 불리므로, 아무 때나 비우면 한창 입력하던
    // 내용이 이유 없이 사라집니다. 그래서 아래 "사람이 바뀌었을 때"에만 비웁니다.
    const key = `${currentEmail}|${admin}`;
    if (key !== lastUserKey) {
        lastUserKey = key;
        loaded = false;
        // 돌고 있는 불러오기를 무효로 만듭니다. 안 그러면 앞사람 때 시작한 것이 뒤늦게
        // 끝나면서 아래에서 비운 선택칸을 도로 채우고 "이미 읽었음"으로 표시해, 뒷사람이
        // 열어도 다시 안 읽습니다.
        loadSeq++;
        document.getElementById("pr-form").reset();
        // 상태 필터는 <form> 밖에 있어서 reset()이 손대지 못합니다. 앞사람이 '반려됨'
        // 으로 좁혀둔 채 나가면, 뒷사람은 이유도 모른 채 반려 건만 보고 "진행 중인
        // 요청이 없구나" 하고 판단합니다.
        document.getElementById("pr-status-filter").value = "전체";
        // 부품·카테고리 선택칸은 비워둡니다. reset()은 앞사람이 보던 목록의 "첫 항목"으로
        // 돌릴 뿐이라, 목록을 다시 읽기 전에 등록하면 여전히 엉뚱한 자재로 올라갑니다.
        // 비워두면 등록을 눌러도 "부품을 선택해주세요"에서 막힙니다.
        document.getElementById("pr-category").innerHTML = "";
        document.getElementById("pr-part").innerHTML = "";
        document.getElementById("pr-stock").textContent = "";
        // 표도 비웁니다. 위의 loaded=false는 "다음에 다시 읽어라"일 뿐이라, 그 읽기가
        // 실패하면 관리자 때 그려진 표(행을 누르면 처리 팝업이 열리는 상태)가 그대로
        // 남아, 일반 사용자가 승인·삭제를 눌러 날것의 DB 권한 오류를 보게 됩니다.
        requests = [];
        applyStatusFilter();
        setStatus("pr-form-status", "");
        // 목록 쪽 문구도 지웁니다. 위에서 무효로 만든 불러오기는 자기가 써둔 "불러오는 중..."
        // 을 지우지 않고 물러나므로, 안 지우면 그 문구가 그대로 멈춰 있습니다.
        setStatus("pr-status", "");

        // 로그아웃 경로는 main.js가 열린 팝업을 닫아 주지만, 로그인 상태로 권한만 바뀌어
        // 여기가 다시 불리는 경로는 닫아주지 않습니다. 게다가 팝업을 닫아도 이 파일이 들고
        // 있는 busy·openRequest는 그대로 남습니다.
        //
        // ⚠️ busy가 true로 남는 것이 특히 나쁩니다. setBusy(false)를 부르는 곳이 처리가
        // 끝나는 자리뿐이라, 앞사람이 승인·입고를 누른 채 로그아웃되면 true로 굳습니다.
        // 그러면 다음 사람이 팝업을 열어도 닫기 버튼까지 잠긴 채라 창을 못 닫습니다.
        // (usage.js·repairs.js에는 이미 있는 처리입니다.)
        const dlg = document.getElementById("pr-dialog");
        if (dlg.open) dlg.close();
        openRequest = null;
        setBusy(false);

        // reset()이 요청자 칸까지 비우므로 여기서 다시 채웁니다. 이 대입이 조건 밖에
        // 있으면 로그인이 자동으로 갱신될 때마다 실행돼서, 동료 이름을 적어둔 사람의
        // 입력이 말없이 계정 이메일로 바뀝니다(요청자는 고쳐 쓰라고 만든 칸입니다).
        document.getElementById("pr-requester").value = currentEmail;
    }

    document.getElementById("pr-admin-hint").classList.toggle("hidden", isAdmin);
}

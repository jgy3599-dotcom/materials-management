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


// 성공하면 null, 실패하면 그 사유를 돌려줍니다. 새로고침이 실패했는데 그 위에
// "삭제했습니다"를 덮어쓰면, 방금 지운 요청이 표에 그대로 남은 채 성공으로 보입니다.
export async function load(force = false) {
    if (loaded && !force) return null;

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
        const reason = describeError(err, "구매 요청을 불러오지 못했습니다.");
        setStatus("pr-status", reason, "error");
        // 다시 읽기에 실패했으면 "이미 읽었다"는 표시를 지웁니다. 안 그러면 메뉴를
        // 오갔다 돌아와도 낡은 표를 그대로 둡니다.
        loaded = false;
        return reason;
    }
    return null;
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

    setBusy(false);
    document.getElementById("pr-dialog").close();
    const reloadError = await load(true);

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

    // ⚠️ 재고는 지운 직후에 바로 읽습니다. 목록 새로고침(자재·요청·이력을 수천 건
    // 받아옴) 뒤에 읽으면 그 몇 초 사이 다른 사람의 출고·입고 한 건만으로도 값이
    // 달라져서, 재고를 건드리지도 않은 '반려됨' 요청을 지웠는데 경고가 뜹니다.
    const afterStock = await readStock(request.material_id);

    setBusy(false);
    document.getElementById("pr-dialog").close();
    const reloadError = await load(true);

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
    const key = `${currentEmail}|${admin}`;
    if (key !== lastUserKey) {
        lastUserKey = key;
        loaded = false;
    }

    document.getElementById("pr-requester").value = currentEmail;
    document.getElementById("pr-admin-hint").classList.toggle("hidden", isAdmin);
}

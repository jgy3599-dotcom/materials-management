// 자재 목록 화면입니다. 전체 자재를 표로 보여주고, 관리자는 행을 눌러 수정/삭제합니다.
import {
    getMaterials, getMaterial, updateMaterial, deleteMaterial,
    adjustMaterialQty, insertAuditLog, getAuditLog,
} from "../db.js";
import { renderTable, redrawTable, downloadTableExcel, getTableRowCount } from "../table.js";
import { setStatus, describeError } from "../ui.js";

// 표에 보여줄 컬럼과 순서입니다. id는 화면에 필요 없어 뺐습니다.
const COLUMNS = [
    "카테고리", "구분", "부품명(규격)", "발주코드", "창고번호", "설치위치",
    "제조사", "거래처", "적용수량", "표준재고", "현재재고", "구매필요", "비고",
];

const AUDIT_COLUMNS = ["일시", "작업", "자재id", "부품명(규격)", "사용자", "이전값", "이후값"];

const TABLE_ID = "materials-table";
const AUDIT_TABLE_ID = "materials-audit-table";

let loaded = false;
let isAdmin = false;
let isSuperAdmin = false;
let currentEmail = "";
let openMaterial = null;   // 지금 팝업에 열려 있는 자재 (팝업을 열 때 DB에서 새로 읽은 값)
let busy = false;          // 저장·삭제가 DB 응답을 기다리는 중인지


// 팝업의 입력칸과 materials 테이블 컬럼을 짝지어 둡니다.
// 저장할 때와 화면을 채울 때 같은 표를 쓰므로, 칸이 늘어도 한 곳만 고치면 됩니다.
// current_qty는 여기 없습니다 — 덮어쓰지 않고 "차이"만 반영하기 때문입니다(아래 saveMaterial 참고).
const FIELDS = {
    category: "mat-category",
    sub_type: "mat-sub-type",
    part_name: "mat-part",
    order_code: "mat-order-code",
    install_location: "mat-location",
    manufacturer: "mat-manufacturer",
    vendor: "mat-vendor",
    in_use_qty: "mat-in-use",
    standard_qty: "mat-standard",
    warehouse_no: "mat-warehouse",
    note: "mat-note",
};

const NUMBER_FIELDS = ["in_use_qty", "standard_qty"];

// 비워두면 빈 글자가 아니라 '값 없음'으로 저장할 칸들입니다.
// 표에서 걸러낼 때 빈 글자와 값 없음이 섞여 있으면 헷갈립니다.
const NULLABLE_FIELDS = ["sub_type", "order_code", "warehouse_no"];


const el = (id) => document.getElementById(id);


// 화면에 처음 들어올 때 한 번만 불러옵니다. 메뉴를 오갈 때마다 다시 받지 않습니다.
// 성공하면 null, 실패하면 그 사유를 돌려줍니다. 저장·삭제 뒤에 목록을 다시 읽을 때
// 그 읽기가 실패했는지 알아야, "됐습니다"라고만 말하고 옛 목록을 그대로 두는 일이 없습니다.
export async function load(force = false) {
    if (loaded && !force) return null;

    setStatus("materials-status", "불러오는 중...");
    try {
        const rows = await getMaterials();
        // 수정 창은 두 번 눌러야 열립니다. 한 번 누르는 것만으로 열리면 표를 훑다가
        // 실수로 열기 쉽습니다. 한 번 누르면 행이 선택만 되어 어느 줄인지 보입니다.
        renderTable(TABLE_ID, rows, COLUMNS, {
            selectable: isAdmin,
            onRowDblClick: isAdmin ? (row) => openDialog(row) : null,
        });
        el("materials-count").textContent =
            `총 ${rows.length.toLocaleString()}건의 자재가 등록되어 있습니다.`;
        setStatus("materials-status", "");
        loaded = true;
    } catch (err) {
        const reason = describeError(err, "자재 목록을 불러오지 못했습니다.");
        setStatus("materials-status", reason, "error");
        // 다시 읽기에 실패했으면 "이미 읽었다"는 표시를 지웁니다. 안 그러면 메뉴를
        // 오갔다 돌아와도 옛 목록을 그대로 두고 다시 읽지 않습니다.
        loaded = false;
        return reason;
    } finally {
        if (isSuperAdmin) loadAuditLog();
    }
    return null;
}


async function loadAuditLog() {
    setStatus("materials-audit-status", "불러오는 중...");
    try {
        renderTable(AUDIT_TABLE_ID, await getAuditLog(), AUDIT_COLUMNS);
        setStatus("materials-audit-status", "");
    } catch (err) {
        setStatus("materials-audit-status",
            describeError(err, "감사 로그를 불러오지 못했습니다."), "error");
    }
}


// ---------------------------------------------------------------------------
// 수정/삭제 팝업
// ---------------------------------------------------------------------------

// 창 안의 모든 칸을 비우고 버튼을 잠급니다.
// ⚠️ 창을 띄우기 "전에" 반드시 불러야 합니다. 앞서 열었던 자재의 값이 남아 있으면,
// 새 자재를 불러오는 짧은 사이에 그 값이 그대로 보이고 삭제 버튼까지 살아 있어서
// 엉뚱한 자재를 지울 수 있습니다.
function resetDialog() {
    for (const inputId of Object.values(FIELDS)) el(inputId).value = "";
    el("mat-current").value = "";
    el("mat-qty-hint").textContent = "";

    el("mat-delete-details").open = false;
    el("mat-delete-confirm").checked = false;
    el("mat-delete-confirm").disabled = true;
    el("mat-delete-btn").disabled = true;
    el("mat-save-btn").disabled = true;
}


// 저장·삭제가 끝난 뒤 창을 닫고 목록을 새로 읽습니다.
// 목록 읽기가 실패했으면 "됐습니다"라고만 말하지 않습니다. 화면에 옛 목록이 그대로
// 남아 있어서, 방금 지운 자재가 아직 보이는 것을 사람이 오해하게 됩니다.
async function finish(okMessage, warnings) {
    el("mat-dialog").close();
    const reloadError = await load(true);

    const notes = [...warnings];
    if (reloadError) notes.push(reloadError);

    setStatus("materials-status",
        notes.length ? `${okMessage}\n\n다만: ${notes.join("\n다만: ")}` : okMessage,
        notes.length ? "error" : "ok");
}


// DB를 기다리는 동안 창을 닫지 못하게 잠급니다.
// 창을 닫고 다른 자재를 열어버리면, 늦게 도착한 앞 자재의 결과가 지금 열린 자재의
// 창을 닫아버리거나 그 자재의 오류인 것처럼 표시됩니다. 아예 닫지 못하게 막는 편이
// 곳곳에서 "지금 것이 맞나" 검사하는 것보다 단순하고 확실합니다.
function setBusy(on) {
    busy = on;
    el("mat-dialog-close").disabled = on;
}


// 표에 그려둔 값이 아니라 DB에서 새로 읽은 값으로 칸을 채웁니다.
// 화면을 오래 열어둔 사이에 다른 사람이 고쳤을 수 있기 때문입니다.
async function openDialog(row) {
    openMaterial = null;
    resetDialog();
    setStatus("mat-dialog-status", "불러오는 중...");
    el("mat-dialog").showModal();

    // 이름을 fresh로 둡니다. loaded는 이 파일 위쪽에서 "목록을 한 번 읽었는가"를
    // 뜻하는 다른 변수라, 같은 이름을 쓰면 나중에 헷갈립니다.
    let fresh;
    try {
        fresh = await getMaterial(row.id);
    } catch (err) {
        setStatus("mat-dialog-status",
            describeError(err, "자재 정보를 불러오지 못했습니다."), "error");
        return;
    }

    if (!fresh) {
        setStatus("mat-dialog-status",
            "이 자재를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.", "error");
        return;
    }

    for (const [col, inputId] of Object.entries(FIELDS)) {
        el(inputId).value = fresh[col] ?? "";
    }
    el("mat-current").value = fresh.current_qty ?? 0;
    el("mat-qty-hint").textContent =
        `현재재고는 지금 값(${fresh.current_qty ?? 0}) 대비 바뀐 만큼만 반영됩니다.`;

    // 다 채운 뒤에야 버튼을 풀고 대상을 정합니다. 여기까지 오지 못하면 저장·삭제는
    // 잠긴 채로 남습니다(불러오기가 실패한 창에서 삭제가 눌리지 않게).
    el("mat-save-btn").disabled = false;
    el("mat-delete-confirm").disabled = false;
    openMaterial = fresh;
    setStatus("mat-dialog-status", "");
}


function readForm() {
    const data = {};
    for (const [col, inputId] of Object.entries(FIELDS)) {
        const raw = el(inputId).value.trim();
        if (NUMBER_FIELDS.includes(col)) data[col] = Number(raw || 0);
        else data[col] = raw === "" && NULLABLE_FIELDS.includes(col) ? null : raw;
    }
    return data;
}


async function saveMaterial(e) {
    e.preventDefault();
    if (!openMaterial) return;

    // ⚠️ 지금 고치는 자재를 여기서 붙잡아 둡니다. 아래에서 DB를 기다리는 동안 사람이
    // 창을 닫고 다른 자재를 열면 openMaterial이 그 자재로 바뀌는데, 그대로 두면
    // A의 재고 변화가 B에 적용됩니다. 삭제 쪽은 이미 이렇게 하고 있었습니다.
    const target = openMaterial;

    const data = readForm();
    if (!data.part_name) {
        setStatus("mat-dialog-status", "부품명(규격)은 반드시 입력해야 합니다.", "error");
        return;
    }

    // 현재재고는 다른 칸처럼 덮어쓰지 않습니다. 창을 연 시점의 값과 견줘서 그 "차이"만
    // DB에 더합니다. 그래야 창을 열어둔 사이에 출고·입고로 재고가 이미 바뀌었더라도
    // 그 변화를 지우지 않고, 사람이 의도한 증감만 반영됩니다.
    //
    // 칸을 비워두면 0으로 읽어서 재고를 통째로 날려버리므로, 비었으면 "안 바꿈"으로 봅니다.
    const before = Number(target.current_qty ?? 0);
    const typed = el("mat-current").value.trim();
    const after = typed === "" ? before : Number(typed);
    if (!Number.isFinite(after)) {
        setStatus("mat-dialog-status", "현재재고는 숫자로 입력해주세요.", "error");
        return;
    }

    const btn = el("mat-save-btn");
    btn.disabled = true;
    setBusy(true);
    setStatus("mat-dialog-status", "");
    const beforeData = { ...target };

    // 항목 저장과 재고 반영은 DB에 따로 나가므로, 앞은 됐는데 뒤가 실패할 수 있습니다.
    // 그때 "전부 실패했다"고 하면 이미 저장된 항목까지 안 된 줄 알게 됩니다.
    try {
        await updateMaterial(target.id, data);
    } catch (err) {
        setStatus("mat-dialog-status", describeError(err, "자재 수정에 실패했습니다."), "error");
        btn.disabled = false;
        setBusy(false);
        return;
    }

    let finalQty = before;
    if (after !== before) {
        try {
            await adjustMaterialQty(target.id, after - before);
            finalQty = after;
            target.current_qty = after;
        } catch (err) {
            // ⚠️ 여기서는 재고가 반영됐는지 안 됐는지 알 수 없습니다. DB는 처리했는데
            // 응답만 못 받았을 수도 있기 때문입니다. 그대로 다시 저장하면 같은 차이가
            // 한 번 더 더해집니다. 그래서 DB에서 지금 값을 다시 읽어 기준을 맞춥니다.
            await recoverAfterAdjustFailure(target, err, data, beforeData);
            btn.disabled = false;
            setBusy(false);
            return;
        }
    }

    // 여기부터는 저장이 끝났습니다. 감사 로그가 실패해도 저장을 되돌리지 않고,
    // "저장은 됐지만 기록은 못 남겼다"고 사실대로 알립니다.
    const warnings = [];
    try {
        await insertAuditLog(currentEmail, "update", target.id, data.part_name,
            beforeData, { ...data, current_qty: finalQty });
    } catch (err) {
        warnings.push(describeError(err, "감사 로그를 남기지 못했습니다."));
    }

    // 음수 재고는 막지 않습니다(실제로 음수인 자재가 있습니다). 다만 있는 것보다 많이
    // 나간 상태라는 뜻이므로 그냥 넘어가지 않고 짚어줍니다.
    if (finalQty < 0) {
        warnings.push(`현재재고가 ${finalQty}개입니다. 있는 것보다 많이 나간 상태라, 재고나 이력을 확인해보세요.`);
    }

    setBusy(false);
    await finish(`'${data.part_name}' 자재가 수정되었습니다.`, warnings);
}


// 재고 반영이 실패했을 때 뒷정리입니다.
// 반영됐는지 알 수 없으므로 DB에서 지금 값을 다시 읽어 기준과 입력칸을 맞춥니다.
// 그래야 사람이 다시 저장을 눌러도 남은 차이만큼만 더해집니다.
// 항목은 이미 저장됐으므로 감사 로그도 여기서 남깁니다(안 그러면 기록 없이 바뀝니다).
async function recoverAfterAdjustFailure(target, err, data, beforeData) {
    let actual = null;
    try {
        actual = await getMaterial(target.id);
    } catch {
        // 다시 읽기도 실패하면 아래에서 안내만 합니다.
    }

    if (actual) {
        target.current_qty = actual.current_qty;
        el("mat-current").value = actual.current_qty ?? 0;
        el("mat-qty-hint").textContent =
            `현재재고는 지금 값(${actual.current_qty ?? 0}) 대비 바뀐 만큼만 반영됩니다.`;
    }

    try {
        await insertAuditLog(currentEmail, "update", target.id, data.part_name,
            beforeData, { ...data, current_qty: actual ? actual.current_qty : "확인필요" });
    } catch {
        // 감사 로그까지 실패하면 아래 안내에 묻어갑니다.
    }

    setStatus("mat-dialog-status",
        describeError(err, actual
            ? "항목은 저장했지만 현재재고 반영은 확실하지 않습니다. 지금 DB 값을 다시 읽어 칸에 넣었으니, 맞는지 보고 다시 저장해주세요."
            : "항목은 저장했지만 현재재고 반영은 확실하지 않고, 지금 값도 읽지 못했습니다. 창을 닫고 다시 열어 확인해주세요."),
        "error");
}


async function removeMaterial() {
    if (!openMaterial) return;

    const btn = el("mat-delete-btn");
    btn.disabled = true;
    setBusy(true);
    setStatus("mat-dialog-status", "");
    const removed = { ...openMaterial };
    try {
        await deleteMaterial(removed.id);
    } catch (err) {
        // 23503은 이 자재를 가리키는 기록이 어딘가에 남아 있어서 DB가 거부한 경우입니다.
        // materials를 가리키는 표가 넷(history·purchase_requests·purchase_history·repairs)이라
        // 어느 쪽인지는 알 수 없으므로 전부 짚어줍니다. 이력만 지우고 다시 눌렀다가
        // 같은 문구를 또 보면 어디를 봐야 할지 알 수 없습니다.
        // 권한 문제 같은 다른 오류까지 같은 문구로 뭉뚱그리지는 않습니다.
        setStatus("mat-dialog-status",
            err?.code === "23503"
                ? "이 자재를 쓴 기록이 남아있어 삭제할 수 없습니다. 입출고 이력 · 구매요청 · 구매이력 · 수리 기록을 확인해주세요."
                : describeError(err, "자재 삭제에 실패했습니다."),
            "error");
        btn.disabled = false;
        setBusy(false);
        return;
    }

    // 자재는 이미 지워졌습니다. 감사 로그가 실패해도 목록은 새로 읽어야 합니다.
    // 안 그러면 지워진 자재가 화면에 남은 채 "삭제 실패"라고 나옵니다.
    const warnings = [];
    try {
        await insertAuditLog(currentEmail, "delete", removed.id, removed.part_name, removed);
    } catch (err) {
        warnings.push(describeError(err, "감사 로그를 남기지 못했습니다."));
    }

    setBusy(false);
    await finish(`'${removed.part_name}' 자재가 삭제되었습니다.`, warnings);
}


export function init() {
    el("materials-excel-btn").addEventListener("click", async () => {
        await downloadTableExcel(TABLE_ID, COLUMNS, "자재목록.xlsx");
    });

    el("materials-reload-btn").addEventListener("click", () => load(true));

    el("mat-dialog-close").addEventListener("click", () => {
        if (!busy) el("mat-dialog").close();
    });
    // Esc 키도 같은 이유로 막습니다. ✕ 버튼만 잠그면 Esc로 빠져나갈 수 있습니다.
    el("mat-dialog").addEventListener("cancel", (e) => {
        if (busy) e.preventDefault();
    });
    el("mat-form").addEventListener("submit", saveMaterial);

    el("mat-delete-confirm").addEventListener("change", (e) => {
        el("mat-delete-btn").disabled = !e.target.checked;
    });
    el("mat-delete-btn").addEventListener("click", removeMaterial);

    // 감사 로그 표는 접힌 채로 만들어집니다. 접혀 있는 동안에는 자리 너비가 0이라
    // 칸 너비가 잘못 잡히므로, 펼칠 때 다시 그립니다.
    el("materials-audit").addEventListener("toggle", (e) => {
        if (e.target.open) redrawTable(AUDIT_TABLE_ID);
    });
}


// 로그인한 사람의 권한에 따라 화면을 조정합니다.
// 사람이 바뀌면 이미 그려둔 표를 버립니다. 표에 행 클릭을 붙일지 말지가 권한에 따라
// 달라지는데, 그대로 두면 앞사람 기준으로 그려진 표가 남습니다.
let lastUserKey = null;

export function setUser(session, admin, superAdmin) {
    isAdmin = admin;
    isSuperAdmin = superAdmin;
    currentEmail = session?.user?.email ?? "";

    const key = `${currentEmail}|${admin}|${superAdmin}`;
    if (key !== lastUserKey) {
        lastUserKey = key;
        loaded = false;
    }

    el("materials-edit-hint").textContent = isAdmin
        ? "고칠 자재의 행을 두 번 클릭하면 수정/삭제 창이 열립니다."
        : "자재 수정/삭제는 관리자만 할 수 있습니다.";
    el("materials-audit").classList.toggle("hidden", !isSuperAdmin);
}


// 표에서 필터한 결과가 몇 건인지 (다른 화면에서 쓸 일이 있으면 사용)
export function visibleCount() {
    return getTableRowCount(TABLE_ID);
}

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
// 성공하면 true를 돌려줍니다. 저장·삭제 뒤에 목록을 다시 읽을 때, 그 읽기가 실패했는지
// 알아야 "됐습니다"라고만 말하고 옛 목록을 그대로 두는 일이 없습니다.
export async function load(force = false) {
    if (loaded && !force) return true;

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
        setStatus("materials-status",
            describeError(err, "자재 목록을 불러오지 못했습니다."), "error");
        return false;
    } finally {
        if (isSuperAdmin) loadAuditLog();
    }
    return true;
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
    const reloaded = await load(true);

    const notes = [...warnings];
    if (!reloaded) notes.push("목록을 새로 읽지 못했습니다. 새로고침을 눌러주세요.");

    setStatus("materials-status",
        notes.length ? `${okMessage}\n\n다만: ${notes.join("\n다만: ")}` : okMessage,
        notes.length ? "error" : "ok");
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
    setStatus("mat-dialog-status", "");
    const beforeData = { ...target };

    // 항목 저장과 재고 반영은 DB에 따로 나가므로, 앞은 됐는데 뒤가 실패할 수 있습니다.
    // 그때 "전부 실패했다"고 하면 이미 저장된 항목까지 안 된 줄 알게 됩니다.
    try {
        await updateMaterial(target.id, data);
    } catch (err) {
        setStatus("mat-dialog-status", describeError(err, "자재 수정에 실패했습니다."), "error");
        btn.disabled = false;
        return;
    }

    if (after !== before) {
        try {
            await adjustMaterialQty(target.id, after - before);
            // 기준값을 옮겨둡니다. 뒤에서 실패해 다시 저장하더라도 같은 차이가
            // 두 번 더해지지 않습니다(10 → 15 → 20 이 되는 것을 막습니다).
            target.current_qty = after;
        } catch (err) {
            setStatus("mat-dialog-status",
                describeError(err, "항목은 저장했지만 현재재고 반영에 실패했습니다. 재고 값을 다시 확인해주세요."),
                "error");
            btn.disabled = false;
            return;
        }
    }

    // 여기부터는 저장이 끝났습니다. 감사 로그가 실패해도 저장을 되돌리지 않고,
    // "저장은 됐지만 기록은 못 남겼다"고 사실대로 알립니다.
    const warnings = [];
    try {
        await insertAuditLog(currentEmail, "update", target.id, data.part_name,
            beforeData, { ...data, current_qty: after });
    } catch (err) {
        warnings.push(describeError(err, "감사 로그를 남기지 못했습니다."));
    }

    await finish(`'${data.part_name}' 자재가 수정되었습니다.`, warnings);
}


async function removeMaterial() {
    if (!openMaterial) return;

    const btn = el("mat-delete-btn");
    btn.disabled = true;
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

    await finish(`'${removed.part_name}' 자재가 삭제되었습니다.`, warnings);
}


export function init() {
    el("materials-excel-btn").addEventListener("click", async () => {
        await downloadTableExcel(TABLE_ID, COLUMNS, "자재목록.xlsx");
    });

    el("materials-reload-btn").addEventListener("click", () => load(true));

    el("mat-dialog-close").addEventListener("click", () => el("mat-dialog").close());
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

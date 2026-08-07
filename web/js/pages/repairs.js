// 수리 관리 화면입니다. 수리 보낸 건들의 현황을 보고, 돌아온 만큼 반납 처리를 합니다.
//
// 수리 건은 여기서 새로 만들지 않습니다. 사용(출고) 등록 시 자재출처를 '한진 SPARE'나
// '한진 구매품'으로 하면 자동으로 생깁니다.
import { getRepairs, getRepairReturns, addRepairReturn } from "../db.js";
import { renderTable, downloadTableExcel } from "../table.js";
import { setStatus, describeError, esc, today } from "../ui.js";

const COLUMNS = ["id", "부품명(규격)", "보낸수량", "반납수량", "상태", "보낸날짜", "보낸곳", "사유", "예상복귀일", "비고"];
const RETURN_COLUMNS = ["반납수량", "반납일", "결과", "비고"];

const TABLE_ID = "repairs-table";
const RETURN_TABLE_ID = "repair-returns-table";

let selected = null;   // 지금 고른 수리 건
let loaded = false;


export async function load(force = false) {
    if (loaded && !force) return;

    setStatus("repairs-status", "불러오는 중...");
    try {
        const rows = await getRepairs();
        renderTable(TABLE_ID, rows, COLUMNS, {
            selectable: true,
            onRowClick: (row) => selectRepair(row),
        });
        document.getElementById("repairs-count").textContent = `${rows.length}건`;
        setStatus("repairs-status", "");
        loaded = true;
    } catch (err) {
        setStatus("repairs-status", describeError(err, "수리 현황을 불러오지 못했습니다."), "error");
        // 다시 읽기에 실패했으면 "이미 읽었다"는 표시를 지웁니다. 안 그러면 메뉴를
        // 오갔다 돌아와도 낡은 내용을 그대로 둡니다.
        loaded = false;
    }
}


// 표에서 수리 건 하나를 고르면 반납 등록 칸과 반납 이력을 보여줍니다.
async function selectRepair(row) {
    selected = row;
    const outstanding = Number(row["보낸수량"]) - Number(row["반납수량"]);

    document.getElementById("repair-detail").classList.remove("hidden");
    document.getElementById("repair-title").innerHTML =
        `<strong>${esc(row["부품명(규격)"])}</strong> 반납 등록 ` +
        `<span class="caption">(보낸 수량 ${esc(row["보낸수량"])}개 중 ${esc(row["반납수량"])}개 반납됨)</span>`;

    const form = document.getElementById("repair-form");
    const doneMsg = document.getElementById("repair-done");
    form.classList.toggle("hidden", outstanding <= 0);
    doneMsg.classList.toggle("hidden", outstanding > 0);

    if (outstanding > 0) {
        const qtyInput = document.getElementById("repair-qty");
        qtyInput.max = outstanding;
        qtyInput.value = 1;
        document.getElementById("repair-date").value = today();
        document.getElementById("repair-note").value = "";
        document.getElementById("repair-outstanding").textContent = `남은 수량: ${outstanding}개`;
    }

    setStatus("repair-form-status", "");

    // 회차별 반납 이력
    try {
        const returns = await getRepairReturns(row.id);
        renderTable(RETURN_TABLE_ID, returns, RETURN_COLUMNS, { pageSize: 10 });
    } catch (err) {
        setStatus("repair-form-status", describeError(err, "반납 이력을 불러오지 못했습니다."), "error");
    }
}


async function submitReturn(e) {
    e.preventDefault();
    if (!selected) return;

    const btn = document.getElementById("repair-submit-btn");
    const qty = Number(document.getElementById("repair-qty").value);
    const outcome = document.getElementById("repair-outcome").value;
    // 자재목록에 없는 부품은 되돌릴 재고 자체가 없어서, 안내 문구를 다르게 보여줍니다.
    const hasMaterial = selected.material_id !== null && selected.material_id !== undefined;

    btn.disabled = true;
    btn.textContent = "등록 중...";
    setStatus("repair-form-status", "");

    try {
        await addRepairReturn(
            selected.id, qty,
            document.getElementById("repair-date").value,
            outcome,
            document.getElementById("repair-note").value.trim(),
        );

        let message;
        if (outcome === "정상복귀" && !hasMaterial) {
            message = `${qty}개 반납 처리했습니다. (자재목록에 없는 부품이라 재고에는 반영하지 않았습니다.)`;
        } else if (outcome === "정상복귀") {
            message = `${qty}개 정상복귀 처리했습니다. 현재재고에 다시 더했습니다.`;
        } else {
            message = `${qty}개 폐기 처리했습니다. 재고는 복구하지 않았습니다.`;
        }
        setStatus("repair-form-status", message, "ok");

        // 표를 새로 읽고, 방금 고른 건을 다시 선택해 남은 수량을 갱신합니다.
        const repairId = selected.id;
        await load(true);
        const updated = (await getRepairs()).find((r) => r.id === repairId);
        if (updated) await selectRepair(updated);
    } catch (err) {
        // 보낸 수량보다 많이 반납하려 하면 DB가 거부하고, 그 안내가 여기 그대로 표시됩니다.
        setStatus("repair-form-status", describeError(err, "반납 등록에 실패했습니다."), "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "반납 등록";
    }
}


export function init() {
    document.getElementById("repairs-reload-btn").addEventListener("click", () => load(true));
    document.getElementById("repairs-excel-btn").addEventListener("click", () =>
        downloadTableExcel(TABLE_ID, COLUMNS, "수리현황.xlsx"));
    document.getElementById("repair-form").addEventListener("submit", submitReturn);
}

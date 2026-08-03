// 자재 목록 화면입니다. 전체 자재를 표로 보여주고 엑셀로 내려받을 수 있습니다.
// (수정/삭제는 아직 옮기지 않았습니다. PORTING.md 참고)
import { getMaterials } from "../db.js";
import { renderTable, downloadTableExcel, getTableRowCount } from "../table.js";

// 표에 보여줄 컬럼과 순서입니다. id는 화면에 필요 없어 뺐습니다.
const COLUMNS = [
    "카테고리", "구분", "부품명(규격)", "발주코드", "창고번호", "설치위치",
    "제조사", "거래처", "적용수량", "표준재고", "현재재고", "구매필요", "비고",
];

const TABLE_ID = "materials-table";
let loaded = false;


function setStatus(message, isError = false) {
    const box = document.getElementById("materials-status");
    box.textContent = message;
    box.className = isError ? "error-msg" : "caption";
    box.classList.toggle("hidden", !message);
}


// 화면에 처음 들어올 때 한 번만 불러옵니다. 메뉴를 오갈 때마다 다시 받지 않습니다.
export async function load(force = false) {
    if (loaded && !force) return;

    setStatus("불러오는 중...");
    try {
        const rows = await getMaterials();
        renderTable(TABLE_ID, rows, COLUMNS);
        document.getElementById("materials-count").textContent =
            `총 ${rows.length.toLocaleString()}건의 자재가 등록되어 있습니다.`;
        setStatus("");
        loaded = true;
    } catch (err) {
        setStatus(`자재 목록을 불러오지 못했습니다. (${err.message ?? err})`, true);
    }
}


export function init() {
    document.getElementById("materials-excel-btn").addEventListener("click", async () => {
        await downloadTableExcel(TABLE_ID, COLUMNS, "자재목록.xlsx");
    });

    document.getElementById("materials-reload-btn").addEventListener("click", () => load(true));
}


// 표에서 필터한 결과가 몇 건인지 (다른 화면에서 쓸 일이 있으면 사용)
export function visibleCount() {
    return getTableRowCount(TABLE_ID);
}

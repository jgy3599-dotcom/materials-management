// 구매 필요 알림 화면입니다. 표준재고보다 부족한 자재를 모아서 보여줍니다.
import { getMaterials } from "../db.js";
import { renderTable, downloadTableExcel } from "../table.js";
import { setStatus, describeError, esc } from "../ui.js";

const COLUMNS = ["카테고리", "구분", "부품명(규격)", "창고번호", "표준재고", "현재재고", "구매필요", "거래처", "비고"];
const TABLE_ID = "alert-table";

let needPurchase = [];
let loaded = false;


function applyFilter() {
    const category = document.getElementById("alert-category").value;
    const rows = category === "전체"
        ? needPurchase
        : needPurchase.filter((m) => m["카테고리"] === category);
    renderTable(TABLE_ID, rows, COLUMNS);
    document.getElementById("alert-count").textContent = `${rows.length}건`;
}


export async function load(force = false) {
    if (loaded && !force) return;

    setStatus("alert-status", "불러오는 중...");
    try {
        const materials = await getMaterials();
        // 부족한 정도가 큰 자재부터 위에 보이도록 정렬합니다.
        needPurchase = materials
            .filter((m) => m["구매필요"] > 0)
            .sort((a, b) => b["구매필요"] - a["구매필요"]);

        const categories = [...new Set(needPurchase.map((m) => m["카테고리"]).filter(Boolean))].sort();
        document.getElementById("alert-category").innerHTML =
            ["전체", ...categories].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");

        applyFilter();
        setStatus("alert-status", "");
        loaded = true;
    } catch (err) {
        setStatus("alert-status", describeError(err, "구매 필요 목록을 불러오지 못했습니다."), "error");
        // 다시 읽기에 실패했으면 "이미 읽었다"는 표시를 지웁니다. 안 그러면 메뉴를
        // 오갔다 돌아와도 낡은 내용을 그대로 둡니다.
        loaded = false;
    }
}


export function init() {
    document.getElementById("alert-category").addEventListener("change", applyFilter);
    document.getElementById("alert-reload-btn").addEventListener("click", () => load(true));
    document.getElementById("alert-excel-btn").addEventListener("click", () =>
        downloadTableExcel(TABLE_ID, COLUMNS, "구매필요목록.xlsx"));
}

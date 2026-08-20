// 구매 필요 알림 화면입니다. 표준재고보다 부족한 자재를 모아서 보여줍니다.
import { getMaterials } from "../db.js";
import { renderTable, downloadTableExcel } from "../table.js";
import { setStatus, describeError, esc, refill } from "../ui.js";

const COLUMNS = ["카테고리", "구분", "부품명(규격)", "창고번호", "표준재고", "현재재고", "구매필요", "거래처", "비고"];
const TABLE_ID = "alert-table";

let needPurchase = [];
let loaded = false;
let loadSeq = 0;       // 불러오기 순번 (늦게 시작한 것만 화면에 그리려고)


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

    // 순번을 매겨 두고, 나보다 나중에 시작한 것이 있으면 그리지 않고 물러납니다
    // (다른 화면들과 같은 방식). 특히 invalidate가 이 번호를 올리기 때문에, 재고가
    // 바뀌기 전에 시작한 불러오기가 뒤늦게 끝나며 낡은 목록을 그리고 "이미 읽었음"으로
    // 표시하는 것을 막습니다. 그렇게 되면 화면을 열어도 다시 읽지 않습니다.
    const seq = ++loadSeq;

    setStatus("alert-status", "불러오는 중...");
    try {
        const materials = await getMaterials();
        if (seq !== loadSeq) return;
        // 부족한 정도가 큰 자재부터 위에 보이도록 정렬합니다.
        needPurchase = materials
            .filter((m) => m["구매필요"] > 0)
            .sort((a, b) => b["구매필요"] - a["구매필요"]);

        const categories = [...new Set(needPurchase.map((m) => m["카테고리"]).filter(Boolean))].sort();
        // refill은 골라둔 카테고리를 되돌려 놓습니다. innerHTML로 갈아치우면 재고가 바뀔
        // 때마다(refresh.js) 이 화면이 다시 읽히면서 필터가 말없이 '전체'로 풀립니다.
        refill(document.getElementById("alert-category"),
            ["전체", ...categories].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(""));

        applyFilter();
        setStatus("alert-status", "");
        loaded = true;
    } catch (err) {
        if (seq !== loadSeq) return;
        setStatus("alert-status", describeError(err, "구매 필요 목록을 불러오지 못했습니다."), "error");
        // 다시 읽기에 실패했으면 "이미 읽었다"는 표시를 지웁니다. 안 그러면 메뉴를
        // 오갔다 돌아와도 낡은 내용을 그대로 둡니다.
        loaded = false;
    }
}


// 재고나 자재가 바뀌었을 때 main.js가 불러줍니다. 여기서는 "다시 읽어라"고 표시만
// 하고, 실제로 읽는 것은 사용자가 이 화면을 열 때입니다.
export function invalidate() {
    loaded = false;
    loadSeq++;   // 돌고 있던 불러오기가 loaded를 도로 켜지 못하게 무효로 만듭니다
}


export function init() {
    document.getElementById("alert-category").addEventListener("change", applyFilter);
    document.getElementById("alert-reload-btn").addEventListener("click", () => load(true));
    document.getElementById("alert-excel-btn").addEventListener("click", () =>
        downloadTableExcel(TABLE_ID, COLUMNS, "구매필요목록.xlsx"));
}

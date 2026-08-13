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
let loadSeq = 0;       // 불러오기 순번 (늦게 시작한 것만 화면에 그리려고)
let selectSeq = 0;     // 행 선택 순번 (같은 행을 두 번 눌러도 나중 클릭만 그리려고)
let lastUserKey = null;    // 로그인한 사람이 바뀌었는지 가리는 값


// 방금 읽은 행들을 돌려줍니다. 반납 등록처럼 "새로 읽은 뒤 그 안에서 한 건을 찾아야"
// 하는 자리에서 같은 테이블을 또 받지 않게 하려는 것입니다. 못 읽었으면 null입니다.
export async function load(force = false) {
    if (loaded && !force) return null;

    // 새로고침을 연달아 누르거나 반납 등록 중에 겹쳐 돌면, 먼저 시작한 쪽이 늦게 끝나면서
    // 낡은 내용으로 덮어씁니다. 순번을 매겨 두고 나보다 나중에 시작한 것이 있으면
    // 그리지 않고 물러납니다(usage.js와 같은 방식).
    const seq = ++loadSeq;

    setStatus("repairs-status", "불러오는 중...");
    try {
        const rows = await getRepairs();
        if (seq !== loadSeq) return null;
        renderTable(TABLE_ID, rows, COLUMNS, {
            selectable: true,
            onRowClick: (row) => selectRepair(row),
        });
        document.getElementById("repairs-count").textContent = `${rows.length}건`;
        setStatus("repairs-status", "");
        loaded = true;
        return rows;
    } catch (err) {
        if (seq !== loadSeq) return null;
        setStatus("repairs-status", describeError(err, "수리 현황을 불러오지 못했습니다."), "error");
        // 다시 읽기에 실패했으면 "이미 읽었다"는 표시를 지웁니다. 안 그러면 메뉴를
        // 오갔다 돌아와도 낡은 내용을 그대로 둡니다.
        loaded = false;
        return null;
    }
}


// 표에서 수리 건 하나를 고르면 반납 등록 칸과 반납 이력을 보여줍니다.
// 반납 이력까지 제대로 그렸으면 true, 도중에 다른 행으로 밀려났거나 이력을 못
// 받아왔으면 false를 돌려줍니다 — submitReturn이 이 값으로 "성공 안내를 덮어써도
// 되는 상태인지"를 판단합니다.
async function selectRepair(row) {
    selected = row;
    // 같은 행을 연달아 두 번 누르면 selected.id 비교만으로는 어느 응답이 최신인지
    // 못 가립니다(둘 다 id가 같으므로). 호출마다 순번을 매겨 나중에 시작한 것만 그립니다.
    const seq = ++selectSeq;
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
        // 결과도 매번 '정상복귀'로 되돌립니다. 이 칸만 안 되돌리면 앞서 고른 건에서 '폐기'로
        // 바꾼 것이 다음 건에도 그대로 남아, 재고를 되돌려야 할 반납이 폐기로 기록됩니다.
        document.getElementById("repair-outcome").value = "정상복귀";
        document.getElementById("repair-outstanding").textContent = `남은 수량: ${outstanding}개`;
    }

    setStatus("repair-form-status", "");
    // 앞서 보던 건의 반납 이력을 먼저 비웁니다. 위에서 제목과 남은 수량은 바로 바뀌는데
    // 이력은 받아온 뒤에야 바뀌므로, 그 사이에 다른 건의 이력이 붙어 보입니다.
    renderTable(RETURN_TABLE_ID, [], RETURN_COLUMNS, { pageSize: 10 });

    // 회차별 반납 이력
    //
    // 받아온 뒤에 "아직 이 호출이 최신인지" 순번으로 확인합니다. 행을 빠르게 A→B로
    // 눌렀을 때 A의 응답이 늦게 오면, 화면에는 B의 제목·남은 수량이 떠 있는데 이력만
    // A의 것이 그려질 수 있기 때문입니다.
    try {
        const returns = await getRepairReturns(row.id);
        if (seq !== selectSeq) return false;
        renderTable(RETURN_TABLE_ID, returns, RETURN_COLUMNS, { pageSize: 10 });
        return true;
    } catch (err) {
        if (seq !== selectSeq) return false;
        setStatus("repair-form-status", describeError(err, "반납 이력을 불러오지 못했습니다."), "error");
        // 여기서는 false가 아니라 true를 돌려줍니다. 이력 "표"를 못 받아온 것뿐이고,
        // 반납 자체(재고 반영)는 이미 끝난 상태라서, submitReturn이 이걸 이유로 성공
        // 안내를 숨기면 사용자가 실패로 착각하고 다시 눌러 반납이 두 번 잡힐 수 있습니다.
        return true;
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
    // 수리 건 번호도 등록을 보내기 "전에" 잡아둡니다. 등록이 오가는 동안 자동 로그아웃이나
    // 다른 탭에서의 로그아웃이 걸리면 setUser가 selected를 비우는데, 그때 아래에서 selected를
    // 읽으면 오류가 나고 "등록 실패"로 보입니다. 실제로는 DB에 반납이 들어가 재고까지
    // 되돌아간 상태라, 사람이 한 번 더 누르면 반납이 두 번 잡힙니다.
    const repairId = selected.id;

    btn.disabled = true;
    btn.textContent = "등록 중...";
    setStatus("repair-form-status", "");

    try {
        await addRepairReturn(
            repairId, qty,
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
        // 표를 새로 읽고, 방금 고른 건을 다시 선택해 남은 수량을 갱신합니다.
        const rows = await load(true);

        // 여기까지 오는 사이 사람이 바뀌었거나(공용 계정 로그아웃/로그인) 다른 건을
        // 클릭했으면 selected가 이미 바뀌어 있습니다. 그런데도 그냥 진행하면 이 반납의
        // 성공 안내와 상세창이 지금 화면(다른 사람 또는 다른 건)에 뒤늦게 튀어나옵니다.
        if (selected?.id !== repairId) return;

        const updated = rows?.find((r) => r.id === repairId);
        const detailShown = updated ? await selectRepair(updated) : false;

        // selectRepair가 기다리는 동안 다른 행으로 옮겨갔으면(그러면 selectRepair가
        // 자기 안전장치로 false를 돌려줌) 아래 성공 안내가 지금 화면과 안 맞으니
        // 여기서 그만둡니다. (이력 조회만 실패한 경우는 true이므로 계속 진행합니다.)
        if (updated && !detailShown) return;

        // 안내 문구는 다시 선택한 "뒤에" 보여줍니다. selectRepair가 폼을 새로 채우면서
        // 안내 문구를 지우기 때문입니다.
        //
        // 다시 읽지 못했으면(다른 새로고침이 끼어들었거나 조회가 실패했으면) 남은 수량이
        // 갱신되지 않은 폼이 그대로 남습니다. 그 상태로 또 누르면 같은 반납이 두 번
        // 들어갈 수 있으므로, 성공은 성공대로 알리되 확인이 필요하다고 덧붙입니다.
        setStatus("repair-form-status",
            updated ? message : `${message}\n\n⚠️ 표를 새로 읽지 못해 남은 수량이 갱신되지 않았습니다. 새로고침으로 확인해주세요.`,
            updated ? "ok" : "warn");
    } catch (err) {
        // 성공 경로(위 147행)와 같은 이유로, 여기 오는 사이 사람이 바뀌었거나 다른 건을
        // 클릭했으면 이 실패 안내는 이제 화면에 없는 건에 대한 것이니 보여주지 않습니다.
        if (selected?.id !== repairId) return;
        // 보낸 수량보다 많이 반납하려 하면 DB가 거부하고, 그 안내가 여기 그대로 표시됩니다.
        setStatus("repair-form-status", describeError(err, "반납 등록에 실패했습니다."), "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "반납 등록";
    }
}


// 사람이 바뀌면 앞사람이 고른 수리 건과 열려 있던 반납 폼을 버립니다. 로그아웃할 때와
// 로그인할 때 양쪽에서 불립니다 — main.js의 render() 참고.
//
// ⚠️ usage.js의 setUser와 같은 이유입니다. 일반 사용자는 공용 계정 하나를 여럿이 함께 쓰기
// 때문에 이메일만 비교하면 정작 사람이 바뀌는 경우에 안 비워집니다. 반납 등록은 결과가
// '정상복귀'면 현재재고를 다시 더하므로, 앞사람이 골라둔 건이 남아 있으면 뒷사람이 누르는
// 순간 자기가 고르지도 않은 자재의 재고가 늘어납니다.
export function setUser(session) {
    const key = session?.user?.email ?? "";
    if (key && key === lastUserKey) return;

    lastUserKey = key;
    loaded = false;
    // 돌고 있는 불러오기를 무효로 만듭니다. 안 그러면 앞사람 때 시작한 것이 뒤늦게 끝나면서
    // 앞사람이 보던 내용을 그리고 "이미 읽었음"으로 표시해, 뒷사람이 열어도 다시 안 읽습니다.
    loadSeq++;
    // selectRepair()도 돌고 있었을 수 있습니다(앞사람이 행을 누른 직후 로그아웃 등).
    // 그대로 두면 뒤늦게 도착한 응답이 순번은 그대로라 통과해서, 지금은 비어 있는
    // 상세창에 앞사람의 반납 이력을 그릴 수 있습니다.
    selectSeq++;
    selected = null;
    document.getElementById("repair-detail").classList.add("hidden");
    // 앞사람이 보던 표도 비웁니다. 남겨두면 뒤이은 다시 읽기가 실패했을 때, 빨간 오류가
    // 뜬 화면에서 앞사람 시점의 행을 눌러 반납 폼을 열 수 있습니다. 그 폼의 '남은 수량'은
    // 지금 값이 아니라 그때 값입니다.
    renderTable(TABLE_ID, [], COLUMNS, { selectable: true });
    document.getElementById("repairs-count").textContent = "";
    // 폼도 비웁니다. 특히 결과 칸('정상복귀'/'폐기')은 재고를 되돌릴지를 정하는 칸인데,
    // 앞사람이 '폐기'로 바꿔둔 것이 남으면 뒷사람의 반납이 폐기로 기록됩니다.
    document.getElementById("repair-form").reset();
    // form.reset()은 버튼의 disabled·문구까지는 안 되돌립니다. 앞사람이 등록 버튼을
    // 누른 채로 로그아웃하면, 그 요청이 끝날 때까지 뒷사람이 못 누르게 됩니다.
    const submitBtn = document.getElementById("repair-submit-btn");
    submitBtn.disabled = false;
    submitBtn.textContent = "반납 등록";
    setStatus("repairs-status", "");
    setStatus("repair-form-status", "");
}


export function init() {
    document.getElementById("repairs-reload-btn").addEventListener("click", () => load(true));
    document.getElementById("repairs-excel-btn").addEventListener("click", () =>
        downloadTableExcel(TABLE_ID, COLUMNS, "수리현황.xlsx"));
    document.getElementById("repair-form").addEventListener("submit", submitReturn);
}

// 자재 등록 화면입니다.
import { getCategories, insertMaterial, insertAuditLog } from "../db.js";
import { setStatus, describeError, esc } from "../ui.js";
import { dataChanged } from "../refresh.js";

const NEW_CATEGORY = "➕ 새 카테고리 직접 입력";

let categories = [];
let loaded = false;
let admin = false;
let userEmail = "";
let lastUserKey = null;    // 로그인한 사람이 바뀌었는지 가리는 값
let loadSeq = 0;           // 불러오기 순번 (늦게 시작한 것만 화면에 그리려고)


// 기존 카테고리를 선택지로 만듭니다.
// "직접 입력"은 관리자에게만 보여줍니다. 오타로 새 카테고리가 잘못 생기는 걸 막기 위해서입니다.
function fillCategoryOptions() {
    const options = admin ? [...categories, NEW_CATEGORY] : categories;
    document.getElementById("reg-category").innerHTML =
        options.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    updateNewCategoryBox();
}


function updateNewCategoryBox() {
    const isNew = document.getElementById("reg-category").value === NEW_CATEGORY;
    document.getElementById("reg-new-category-box").classList.toggle("hidden", !isNew);
}


export async function load(force = false) {
    if (loaded && !force) return;

    // 순번을 매겨 두고, 나보다 나중에 시작한 것이 있으면 물러납니다. 겹쳐 돌면 늦게 끝난
    // 쪽이 fillCategoryOptions()로 카테고리 칸을 통째로 갈아치우는데, 그 사이 사용자가
    // 골라둔 카테고리가 말없이 첫 항목으로 되돌아가 엉뚱한 카테고리로 등록됩니다.
    const seq = ++loadSeq;

    setStatus("reg-status", "불러오는 중...");
    try {
        const rows = await getCategories();
        if (seq !== loadSeq) return;
        categories = rows;
        fillCategoryOptions();
        setStatus("reg-status", "");
        loaded = true;
    } catch (err) {
        if (seq !== loadSeq) return;
        setStatus("reg-status", describeError(err, "카테고리 목록을 불러오지 못했습니다."), "error");
        // 다시 읽기에 실패했으면 "이미 읽었다"는 표시를 지웁니다. 안 그러면 메뉴를
        // 오갔다 돌아와도 낡은 내용을 그대로 둡니다.
        loaded = false;
    }
}


// 재고나 자재가 바뀌었을 때 main.js가 불러줍니다. 여기서는 "다시 읽어라"고 표시만
// 하고, 실제로 읽는 것은 사용자가 이 화면을 열 때입니다.
// (이 화면이 들고 있는 것은 카테고리 목록입니다. 자재를 새로 등록하면 없던 카테고리가
//  생길 수 있어서 같이 다시 읽습니다.)
export function invalidate() {
    loaded = false;
    loadSeq++;   // 돌고 있던 불러오기가 loaded를 도로 켜지 못하게 무효로 만듭니다
}


function value(id) {
    return document.getElementById(id).value.trim();
}


async function submit(e) {
    e.preventDefault();

    const categoryChoice = document.getElementById("reg-category").value;
    const newCategory = value("reg-new-category");
    const partName = value("reg-part");

    if (!partName) {
        setStatus("reg-form-status", "부품명(규격)은 반드시 입력해야 합니다.", "error");
        return;
    }
    if (categoryChoice === NEW_CATEGORY && !newCategory) {
        setStatus("reg-form-status", "새 카테고리명을 입력해주세요.", "error");
        return;
    }

    const data = {
        category: categoryChoice === NEW_CATEGORY ? newCategory : categoryChoice,
        sub_type: value("reg-subtype") || null,
        part_name: partName,
        order_code: value("reg-order-code") || null,
        install_location: value("reg-location"),
        manufacturer: value("reg-manufacturer"),
        vendor: value("reg-vendor"),
        in_use_qty: Number(document.getElementById("reg-in-use").value),
        standard_qty: Number(document.getElementById("reg-standard").value),
        current_qty: Number(document.getElementById("reg-current").value),
        warehouse_no: value("reg-warehouse") || null,
        note: value("reg-note"),
    };

    // 등록이 오가는 사이 자동 로그아웃이나 다른 탭에서의 로그아웃이 걸리면 userEmail이
    // 빈 문자열로 바뀝니다. 감사 로그의 "누가 했는지"는 지금 이 사람이어야 하므로,
    // 보내기 "전에" 붙잡아 둡니다.
    const actorEmail = userEmail;
    // 지금 사람도 붙잡아 둡니다. 아래에서 폼을 비우고 안내를 쓰는데, 그 사이 사람이
    // 바뀌었다면 뒷사람이 입력하던 내용을 지우고 앞사람의 안내를 띄우게 됩니다.
    const myUserKey = lastUserKey;

    const btn = document.getElementById("reg-submit-btn");
    btn.disabled = true;
    btn.textContent = "등록 중...";
    setStatus("reg-form-status", "");

    try {
        let newId;
        try {
            newId = await insertMaterial(data);
        } catch (err) {
            // 사람이 바뀌었으면 이 실패 안내도 뒷사람 화면에 띄우지 않습니다.
            if (lastUserKey !== myUserKey) return;
            setStatus("reg-form-status", describeError(err, "자재 등록에 실패했습니다."), "error");
            return;
        }

        // 새 자재가 생겼으니 다른 화면(자재 목록·출고 부품칸 등)의 내용을 낡은 것으로
        // 표시합니다. 이 화면의 카테고리 목록도 함께 꺼지지만, 아래 load(true)가 도로
        // 켜줍니다(사람이 바뀌어 건너뛰더라도 꺼진 채로 남아 다음에 읽습니다).
        dataChanged();

        // 여기서부터 자재는 이미 만들어졌습니다. 감사 로그가 실패했다고 "등록 실패"라고
        // 하면 사용자가 당연히 다시 누르고, 같은 자재가 두 건 생깁니다. 그래서 성공은
        // 성공이라고 말하고 못 한 일만 "다만:" 뒤에 붙입니다(materials.js와 같은 방식).
        const warnings = [];
        try {
            await insertAuditLog(actorEmail, "insert", newId, partName, null, data);
        } catch (err) {
            warnings.push(describeError(err, "감사 로그를 남기지 못했습니다."));
        }

        // 그 사이 사람이 바뀌었으면 여기서 그만둡니다. 등록 자체는 이미 끝났고, 아래의
        // 폼 비우기와 안내는 지금 화면을 보고 있는 사람의 것이 아닙니다.
        // 다만 아래 load(true)를 건너뛰게 되므로, 새 카테고리를 만든 등록이었다면 목록이
        // 낡은 채로 남습니다. "다시 읽어야 한다"고 표시해 다음에 이 화면을 열 때 읽게 합니다.
        if (lastUserKey !== myUserKey) {
            loaded = false;
            // 화면에는 못 띄우지만 감사 로그를 못 남긴 것까지 조용히 넘기지는 않습니다.
            // 자재는 DB에 들어갔는데 누가 넣었는지가 없는 상태라 흔적은 남겨야 합니다.
            if (warnings.length) console.error(`자재 등록(id=${newId}) 후:`, warnings.join(" / "));
            return;
        }

        document.getElementById("reg-form").reset();
        document.getElementById("reg-manufacturer").value = "-";
        document.getElementById("reg-vendor").value = "-";

        const okMessage = `'${partName}' 자재가 등록되었습니다.`;
        setStatus("reg-form-status",
            warnings.length ? `${okMessage}\n\n다만: ${warnings.join("\n다만: ")}` : okMessage,
            warnings.length ? "warn" : "ok");

        // 새 카테고리가 생겼을 수 있어 목록을 다시 읽습니다. 안내를 "먼저" 띄우는 이유는,
        // 이 기다림 사이에도 사람이 바뀔 수 있어서입니다. 그때 뒤에 띄우면 앞사람의 성공
        // 안내가 뒷사람 화면에 뜹니다(load는 reg-form-status를 건드리지 않습니다).
        await load(true);
    } finally {
        btn.disabled = false;
        btn.textContent = "등록하기";
    }
}


export function init() {
    document.getElementById("reg-category").addEventListener("change", updateNewCategoryBox);
    document.getElementById("reg-form").addEventListener("submit", submit);
}


// 사람이 바뀌면 앞사람이 입력해둔 것을 버립니다. 로그아웃할 때와 로그인할 때 양쪽에서
// 불립니다 — main.js의 render() 참고.
//
// ⚠️ 일반 사용자는 공용 계정 하나를 여럿이 함께 쓰기 때문에, 로그인할 때만 비우면
// 이메일이 같아 그냥 지나갑니다. 앞사람이 채워둔 부품명·수량이 남아 있으면 뒷사람이
// 자기가 적지도 않은 자재를 등록하게 되고, 감사 로그에는 뒷사람 이름으로 남습니다.
//
// 반대로 아무 때나 비우면 안 됩니다. 이 함수는 로그인이 자동으로 갱신될 때도 불리는데,
// 그때 비우면 한창 입력하던 내용이 이유 없이 사라집니다. 그래서 "사람이 바뀌었을 때만"
// 비웁니다(usage.js·repairs.js와 같은 방식).
export function setUser(session, isAdminUser) {
    admin = isAdminUser;
    userEmail = session?.user?.email ?? "";

    // ⚠️ 사람이 안 바뀌었으면 화면을 아예 건드리지 않고 나갑니다. 예전에는 아래
    // fillCategoryOptions()가 이 바깥에 있었는데, 그러면 로그인이 자동으로 갱신될 때마다
    // 카테고리 칸을 통째로 다시 그려서 골라둔 카테고리가 말없이 첫 항목으로 되돌아갔고,
    // 그대로 등록하면 엉뚱한 카테고리로 자재가 들어갔습니다.
    const key = `${userEmail}|${admin}`;
    if (key === lastUserKey) return;
    lastUserKey = key;

    // 돌고 있는 불러오기를 무효로 만듭니다. 앞사람 때 시작한 것이 뒤늦게 끝나면서
    // 카테고리 칸을 다시 채우지 않게 합니다.
    loadSeq++;
    // 카테고리도 다시 읽게 합니다. 위에서 무효로 만든 불러오기는 loaded를 건드리지 않고
    // 물러나므로, 여기서 안 지우면 "이미 읽었음"인 채로 남아 다음 사람이 열어도 다시
    // 안 읽고, 그 사이 새로 생긴 카테고리가 계속 안 보입니다.
    loaded = false;
    document.getElementById("reg-form").reset();
    // 선택지 자체도 비웁니다. reset()은 고른 값만 되돌릴 뿐이라, 다시 읽기가 실패하면
    // 관리자에게만 보여야 할 '➕ 새 카테고리 직접 입력'이 일반 사용자 화면에 남습니다.
    document.getElementById("reg-category").innerHTML = "";
    // 카테고리 칸이 '새 카테고리 직접 입력'에 가 있었으면 그 입력칸도 다시 숨깁니다.
    updateNewCategoryBox();
    setStatus("reg-form-status", "");
    setStatus("reg-status", "");
}

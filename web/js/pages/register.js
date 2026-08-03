// 자재 등록 화면입니다.
import { getMaterials, insertMaterial, insertAuditLog } from "../db.js";
import { setStatus, describeError, esc } from "../ui.js";

const NEW_CATEGORY = "➕ 새 카테고리 직접 입력";

let materials = [];
let loaded = false;
let admin = false;
let userEmail = "";


// 기존 카테고리를 선택지로 만듭니다.
// "직접 입력"은 관리자에게만 보여줍니다. 오타로 새 카테고리가 잘못 생기는 걸 막기 위해서입니다.
function fillCategoryOptions() {
    const categories = [...new Set(materials.map((m) => m["카테고리"]).filter(Boolean))].sort();
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
    setStatus("reg-status", "불러오는 중...");
    try {
        materials = await getMaterials();
        fillCategoryOptions();
        setStatus("reg-status", "");
        loaded = true;
    } catch (err) {
        setStatus("reg-status", describeError(err, "카테고리 목록을 불러오지 못했습니다."), "error");
    }
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

    const btn = document.getElementById("reg-submit-btn");
    btn.disabled = true;
    btn.textContent = "등록 중...";
    setStatus("reg-form-status", "");

    try {
        const newId = await insertMaterial(data);
        await insertAuditLog(userEmail, "insert", newId, partName, null, data);

        setStatus("reg-form-status", `'${partName}' 자재가 등록되었습니다.`, "ok");
        document.getElementById("reg-form").reset();
        document.getElementById("reg-manufacturer").value = "-";
        document.getElementById("reg-vendor").value = "-";
        await load(true);   // 새 카테고리가 생겼을 수 있어 목록을 다시 읽습니다
    } catch (err) {
        setStatus("reg-form-status", describeError(err, "자재 등록에 실패했습니다."), "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "등록하기";
    }
}


export function init() {
    document.getElementById("reg-category").addEventListener("change", updateNewCategoryBox);
    document.getElementById("reg-form").addEventListener("submit", submit);
}


export function setUser(session, isAdminUser) {
    admin = isAdminUser;
    userEmail = session?.user?.email ?? "";
    if (loaded) fillCategoryOptions();
}

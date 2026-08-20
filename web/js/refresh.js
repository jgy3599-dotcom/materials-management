// 재고나 자재가 바뀌었을 때, 다른 화면들에게 "네가 들고 있는 내용은 낡았다"고 알립니다.
//
// 화면마다 "한 번 읽었으면 다시 안 읽는다"는 표시(loaded)를 들고 있습니다. 그래서 출고를
// 등록해 재고가 줄어도, 자재 목록·구매 필요 알림은 새로고침을 누르기 전까지 옛 숫자를
// 그대로 보여줬습니다.
//
// 화면 파일이 main.js를 직접 부르면 서로 물고 도는(순환) import가 되므로, 가운데에
// 이 작은 파일을 둡니다. 화면은 여기에 "바뀌었다"고 알리기만 하고, 누가 그 신호를
// 받는지는 main.js가 정합니다.
//
// 다시 읽는 것은 사용자가 그 메뉴를 열 때입니다(main.js의 goToPage가 load()를 부릅니다).
// 여기서는 표시만 지웁니다.

const listeners = [];


export function onDataChanged(fn) {
    listeners.push(fn);
}


export function dataChanged() {
    for (const fn of listeners) fn();
}

// Supabase에 접속하는 객체를 만들어 다른 파일들이 가져다 쓰게 합니다.
//
// 빌드 과정(npm 등) 없이 쓰려고 CDN에서 바로 불러옵니다. 회사 네트워크가 CDN을 막으면
// 이 줄에서 실패하는데, 그때는 라이브러리 파일을 web/vendor/ 에 직접 넣고 경로만 바꾸면 됩니다.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        // 로그인 상태를 브라우저에 저장해서, 새로고침하거나 창을 닫았다 열어도 유지되게 합니다.
        persistSession: true,
        autoRefreshToken: true,
    },
});

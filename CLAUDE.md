# CLAUDE.md
Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.
Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding
**Don't assume. Don't hide confusion. Surface tradeoffs.**
Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so.
- Push back when warranted. If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First
**Minimum code that solves the problem.**
- Nothing speculative. No features beyond what was asked.
- No abstractions for single-use code. No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes
**Touch only what you must. Clean up only your own mess.**
When editing existing code:
- Don't "improve" adjacent code, comments, or formatting. Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- When your changes create orphans: Remove imports/variables/functions that YOUR changes made unused. Don't remove pre-existing dead code unless asked.
- The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution
**Define success criteria. Loop until verified.**
Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make them pass"
For multi-step tasks, state a brief plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]

---

# User Environment & Technology Stack
- **OS:** Windows (개발은 개인 노트북, 최종 구동은 회사 노트북 웹앱 환경)
- **Language:** Python 3.x
- **Framework:** Streamlit (초보자용 쉽고 강력한 웹 프레임워크)
## Special Instruction
- 사용자는 완전 코딩 초보자이므로, 모든 코드를 수정하거나 명령어를 실행하기 전에 초보자 눈높이에 맞춰 한 줄씩 친절하게 설명해 줄 것.
- **반드시 모든 답변과 설명은 100% 한국어(Korean)로만 작성할 것.**

## Development Commands
- **웹앱 실행:** `streamlit run app.py`
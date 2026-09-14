# JLPT 練習 — 專案狀態

線上版：https://yolin0513.github.io/jlpt-app/
目前版本：v1.13.0（Service Worker `jlpt-v1.12.0`）

## 開發流程慣例

1. **規劃階段**：由共用的 **Fable 5.1（effort high）統籌 Session** 理解 Yolin 的需求、拆解並寫成規格，規格檔放在本 App 的 `docs/`，命名為 `SPEC_<主題>.md`。
2. **開發階段**：本 Session 使用 **Opus 5**，平常 effort **high**；只有 Yolin 明講是大工程時才切 **Max**。Opus 負責實作，也負責查找、蒐集資料。
3. **流程**：Fable 寫 spec → Opus 實作＋查資料 → 回報並與需求（spec）逐項對照 → 與 Yolin 確認。
4. **較大改動或值得討論的議題**：由 Fable 開 3 個代理投票；各代理擔任統籌，把查資料的工作交給 Opus，Fable 彙整投票結果後再回報。
5. **測試紀律**：沿用下方「測試紀律」既有慣例，不因分工調整而改變。

## 測試紀律

- **新斷言必須驗證會紅（mutation 驗證）**：拿修正前的程式碼（例如尚未部署修正的線上版，或暫時還原修正）跑一次，確認斷言確實失敗，才算有效。
- **不寫假斷言**：不留永遠會過的斷言；隨機出題的輸出不得綁死單一結果。
- 測試若依賴某個設定（例如每日目標），要在該節自行明確設定，避免分節之間狀態污染。
- 有新行為就補斷言；修 bug 時要補一條「修正前會紅」的回歸斷言，並說明既有測試為何沒抓到。
- 測試三件套：`scripts/audit.mjs`（97 項）、`scripts/verify-full.mjs`（30 項）、`scripts/regress.mjs`（23 項）。先跑 `python scripts/serve.py`；部署後以線上網址再跑一次。

## 資料慣例

- 題庫新條目一律附加在 `data/src/*.txt` **檔尾**（id 依行序編號，中間插入會位移 id、對不上使用者已存的進度），改完跑 `python scripts/build_data.py` 與 `python scripts/check_data.py`。
- 跨級別重複用 `data/src/dedup.txt` 在載入時隱藏，不從來源檔刪行。

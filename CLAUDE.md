# JLPT 練習 App — 給 Claude 的專案指示

**開工前先讀 [`docs/STATUS.md`](docs/STATUS.md)**：開頭的「目前進行中／交接」寫著上一個 Session 做到哪、下一步是什麼；
§2 是正在等 Yolin 決定的事；§7「被否決的方案」與 §8「踩過的坑」可以省很多冤枉路。
**STATUS.md 是唯一的真相來源**——Session 的記憶檔不會跟著專案走，新的決定、規則、踩坑請直接寫進 STATUS.md。

## 常設規則（必須遵守）

1. **全程繁體中文**：思考／判斷過程的文字敘述與回覆都用繁體中文（含理由、選項、建議、進度回報、結論）。
   程式碼、變數名、檔名、專有名詞、引用出處維持原樣，不必硬翻。
2. **嚴禁互動式提示框**：不得使用 AskUserQuestion 或任何會跳出選單／多選題的互動工具。
   Yolin 常從手機或其他電腦遠端操作，提示框只渲染在本機 PC，遠端點不到會讓 Session 卡死。
   需要 Yolin 決定的事，一律在回覆裡用**純文字**列出選項並附上建議，然後停下等待（由 Dispatch 轉達）。
3. **授權邊界**（本專案 `D:\Claude\App\JLPT_App` 內，詳見 STATUS §3.2）：
   - **免問，直接做、做完回報**：改程式、補題庫、加測試、建檔、搬移檔案、安裝本機開發工具、一般 git（commit／push／建分支）、部署到 GitHub Pages、刪除**尚未 commit** 的暫存檔。
   - **先確認**：刪除已 commit 的檔案或大量題庫條目（STATUS §2 Q2 待釐清，可能改為投票）。
   - **異動較大**（判定清單見 STATUS §3.3）：先走多代理投票（由 Fable 主持），再動手。
     force push、`git reset --hard`、`git clean`、刪分支、改寫已推送的歷史都屬此類，需要時由 Yolin 本人執行。
     **`.claude/settings.json` 的 deny 只擋得住幾種特定寫法，不是安全網**（例如 `git push origin +main`、`git rebase`、`git -c … push --force` 都擋不到），要靠自律；清單見 STATUS §3.2。
4. **跨專案唯讀**：`D:\Claude\App\` 底下的其他專案（TripQuest、StockDiary、MealMate 等）只能讀、不能改；本專案以外的任何檔案都不要動。
5. **repo 是 public**：commit 內容與所有文件（包括本檔、STATUS、SPEC）不得出現金鑰／token、真實 email、
   **本機 Windows 使用者名稱、本機 Claude 工作階段路徑或 UUID**；路徑一律用 `$HOME`、`~` 或代稱。程式不寫死本機路徑，改讀環境變數。
6. **題庫鐵則**：新條目**只能附加在 `data/src/*.txt` 檔尾**。id 依**有效資料列**的順序編號（`n5-v-0001`…；註解、空行、被 build 略過的壞行不算），是使用者 IndexedDB 進度的 key：
   在中間插入或刪除資料列、或把某一行改壞（欄位空掉、混入西里爾字母）都會讓後面的 id 位移。修改既有條目只能就地改欄位，
   **rebuild 後逐筆比對既有 id 的內容沒變**（做法見 STATUS §5）。跨級重複用 `data/src/dedup.txt` 在載入時隱藏。
   同一輪的題庫草稿要**一次全部**丟給 `scripts/filter_vocab_draft.mjs` 或 `scripts/filter_grammar_draft.mjs` 過濾。
7. **測試紀律**：新斷言必須驗證「修正前會紅」（mutation 驗證）；不寫假斷言；隨機輸出不得綁死單一結果。
   修 bug 回報固定三件事：根因、為什麼既有測試沒抓到、補了哪些斷言。
8. **不主動截圖**：除非 Yolin 要求，否則不產生截圖；但仍要用程式化方式（puppeteer 讀 DOM）驗證。
9. **不接需要付費或金鑰的外部服務**；評估後真的沒有其他路，先停下來問 Yolin。

## 常用指令

```bash
python scripts/build_data.py          # data/src/*.txt → data/**/*.json、manifest、搜尋索引、羅馬字
python scripts/check_data.py          # 題庫品質檢查（可加 --sample N）
python scripts/serve.py               # 開發伺服器 http://localhost:5173/（多執行緒；不要用 python -m http.server）

# 本機驗證（注意：verify-full 不帶參數時測的是「線上」，本機一定要帶網址）
node scripts/audit.mjs http://localhost:5173/                 # 全面回歸 113 項
node scripts/verify-full.mjs http://localhost:5173/           # 完整驗證 30 項
node scripts/regress.mjs http://127.0.0.1:5173/index.html     # 路由與互動回歸 23 項

# 部署後對線上版再跑一次
node scripts/audit.mjs https://yolin0513.github.io/jlpt-app/
node scripts/verify-full.mjs https://yolin0513.github.io/jlpt-app/
node scripts/regress.mjs https://yolin0513.github.io/jlpt-app/index.html
```

push 一般的 `git push` 會卡在看不到的 GUI 登入視窗，一律用這條（gh 放在使用者 Temp 目錄，見 STATUS §8）：

```bash
GIT_TERMINAL_PROMPT=0 GH_CONFIG_DIR="$HOME/.config/gh" timeout 90 git -c credential.helper='!"$HOME/AppData/Local/Temp/gh-cli/bin/gh.exe" auth git-credential' push origin main
```

線上版：https://yolin0513.github.io/jlpt-app/ （repo：github.com/yolin0513/jlpt-app，main 分支根目錄部署）

## 共用慣例

四個 App 共用的工作慣例在 `docs/CONVENTIONS.md`。那是副本，主檔在統籌工作區，**不要在這裡改它**。
開工前把它跟 `docs/STATUS.md` 一起讀完，並在第一則回覆的**第一行**寫回執：`已讀共用慣例 vN（日期）`（N 與日期抄副本第一行）。
本檔與 `docs/STATUS.md` 的規則優先於共用慣例；兩邊衝突時照較嚴的做，並在回報裡指出來。

@docs/CONVENTIONS.md

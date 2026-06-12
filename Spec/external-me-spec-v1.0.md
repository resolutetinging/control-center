# External Me — Spec v1.0
**檔案：** `life_tracker_v1.html`
**儲存庫：** `resolutetinging/control-center`
**性質：** 單一 HTML 純前端，零外部依賴（除 Google Fonts Roboto），localStorage 持久化

---

## 1. 頁面名稱 / 定位

**External Me** — 個人多視角公開名片，依受眾切換視角，展示不同身分層面。

---

## 2. 字體 / 配色 Token

```css
font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang TC', sans-serif;

--bg:       #f4f1ec   /* 暖米底色 */
--bg2:      #eceae3
--bg-card:  #f8f6f1
--ink:      #28261f   /* 主文字 */
--sub:      #55514a   /* 次文字 */
--border:   #dcd9d2
--faint:    #9e9890
--sidebar-w: 160px
--track-label-w: 72px
--track-h:   72px
--pipe-h:    7px
--node-d:    17px
--r:         8px
```

**B≥R 原則**：所有 accent 色 Blue channel ≥ Red channel（剛性）

---

## 3. 視角架構（6 lenses）

| `?lens=` | label | 類型 | 顯示內容 |
|---|---|---|---|
| （空）/ `public` | Public | 水管型 | 公眾文字 + 時間軸（dimmed）|
| `photography` | Photography | 獨立版面 | Intro + IG icon + Digital/Film 精選作品 |
| `creative` | Creativity | 獨立版面 | Intro + IG icon + 精選作品 |
| `astrology` | Astrology | 獨立版面 | Intro + 預約連結 + 精選作品 |
| `engineering` | Work | 河流型 | River timeline + Experience（節點/hashtag 篩選）|
| `myself` | All | 河流型 | River timeline（雙軌）+ Switch Lens + inline DM |

`STANDALONE_LENSES = ['photography','creative','astrology']`  
`TRACK_ORDER = ['engineering','divination']`

---

## 4. 路由

```javascript
parseLens()         // 讀 URLSearchParams('lens')，白名單驗證，非法 → 'public'
switchLens(l)       // history.pushState + re-render（無頁面重載）
```

---

## 5. 左側欄 `#status-panel`

- 寬 160px，sticky，所有視角共用
- 內容依 lens 動態渲染（`renderStatusPanel(lens)`）
- **Standalone lenses（攝影/插畫/斗數）**：頭像 + 名字 + IG icon（連結來自 `lensProfiles[lens].instagram`）
- **Engineering**：頭像 + 名字 + LinkedIn icon + Hashtag Filter pills
- **Myself**：圓形頭像（可點擊上傳）+ 名字
- **Public**：預設頭像 + 名字
- 非全觀視角底部有「← All」回歸按鈕

---

## 6. 右側內容區

### 6a. Standalone 版面（`renderStandaloneSection`）
```
Intro block: headline（font-weight:200）/ tagline / intro bio（全寬，white-space:pre-line）
Links block: IG icon 按鈕 / 預約連結按鈕
Preview grid: 3欄 CSS Grid，gap:10px
  → photography: 依 card.cat 分 Digital / Film 兩區
  → creative / astrology: 單一「精選作品」區
```

### 6b. River Timeline（engineering / myself）

**Engineering**（`renderEngTimeline`）：
- 外層 `eng-river-wrap`（隱藏 pl-label）
- 呼叫 `renderRiverTrack('engineering', engTypeColor, 'eng-river-track')`

**All**（`renderMyselfTimeline`）：
- 外層 `myself-river-wrap`（顯示 pl-label）
- 呼叫 `renderRiverTrack('engineering', ...)` + `renderRiverTrack('divination', ...)`

**`renderRiverTrack(trackId, getSegColor, trackClass)`**（共用 helper）：
- 每對相鄰節點間畫一段 `eng-river-seg`（Morandi 色調，`river-flow` 動畫，`animationDelay` 相差 1.8s）
- 段中間文字：`eng-seg-label`（白字，node.label）
- 每個節點：`eng-node-marker`（虛線往上 + `YYYY/MM` 日期標籤）+ `pipe-dot`
- 尾端延伸：最後節點後 0.5 年，opacity 0.45

**Morandi 色系**：
```javascript
ENG_TYPE_COLORS = {
  work:       ['#4a6070','#7a98a8','#4a6070'],  // Morandi 藍
  innovation: ['#4a6878','#7ab0b8','#4a6878'],  // Morandi 青藍
  sabbatical: ['#606878','#9aa8b4','#606878'],  // Morandi 霧藍灰
}
DIV_SEG_COLOR = ['#585070','#8878a8','#585070']  // Morandi 紫
```

### 6c. Engineering Experience（`renderEngSection`）
- **Hashtag 篩選模式**（`_activeEngHashtag !== null`）：顯示對應 `engHashtags[tag].items` 的 Event/Result 卡片
- **預設模式**：工作節點倒序，`visible !== false` 的節點，顯示 R&R bullets

---

## 7. 資料結構（`TINA_DATA_MATRIX`）

```javascript
{
  nodes: MS,          // 里程碑節點陣列，含 visible / type 欄位
  cards: {
    photography: [...],   // { cat:'Digital'|'Film', title, gradient, url? }
    creative:    [...],
    astrology:   [...],
  },
  lensNames: {
    public, photography, creative, astrology, engineering, myself  // 可換行，\n
  },
  avatarImg: '',          // base64，全觀頭像
  lensAvatars: {
    photography, creative, astrology, engineering  // base64
  },
  publicText: '',
  lensProfiles: {
    photography: { headline, tagline, intro, instagram },
    creative:    { headline, tagline, intro, instagram },
    astrology:   { headline, tagline, intro, link },
    engineering: { linkedin },
  },
  engHashtags: [          // 工作維護
    { tag:'', items:[{ event:'', result:'' }] }
  ],
}
```

**Node 欄位**：`id, year, month?, track, label, title, subtitle?, star?, visible?, type?`  
`type` 僅 engineering 節點使用：`'work' | 'innovation' | 'sabbatical'`

---

## 8. 持久化

```javascript
LTO_KEY = 'lto_matrix'
persistData()           // 立即存入 localStorage（try/catch）
schedulePersist()       // 600ms debounce
loadPersistedData()     // init 時讀取，merge 到 TINA_DATA_MATRIX
```

存入欄位：`nodes, cards, lensNames, avatarImg, lensAvatars, publicText, lensProfiles, engHashtags`

---

## 9. 圖片壓縮

```javascript
compressImg(file, maxPx:480, quality:0.82, cb)
// Canvas API → JPEG base64，防 QuotaExceededError
// 非同步：必須在 onload 前 capture target 變數
```

---

## 10. 資料管理中樞（inline，myself 視角）

**Tab 結構**：`nodes（里程碑節點）| cards（預覽卡片）| eng（工作維護）| content（視角內容）| settings（設定）`

| Tab | 功能 |
|---|---|
| nodes | 節點 CRUD + visibility toggle（●/○）+ R&R bullet 編輯 + type 下拉（工作節點）|
| cards | 各 lens 預覽卡片 CRUD；photography cat 為 Digital/Film 下拉 |
| eng | engHashtags CRUD：Hashtag → [Event/Result] 卡片 |
| content | 公眾文字 + 攝影/插畫/斗數 headline/tagline/intro/instagram|link |
| settings | 工作視角 LinkedIn → 頭像設定（全觀上傳 / 各視角頭像）→ 各視角顯示名稱 |

**inline 渲染**：`dmInitBuffers()` + `buildDmTabBar()` + `_dmFormAreaRef` + `dmRefreshForm()`

---

## 11. 技術底線（剛性）

- **100% 禁止 `.innerHTML`**：所有 DOM 用 `el()` + `ap()` + `txt()` + `clearNode()`
- **SVG 元素**：`document.createElementNS(SVG_NS, tag)` + `sattr()`
- **`parseLens()`**：白名單嚴格驗證，非法 lens → 'public'
- **B≥R 原則**：所有 accent 色 Blue ≥ Red
- **`renderContent`**：每次重置 `area.className='content-area'`，防 class 殘留

---

## 12. CC Gist 同步

`lto_matrix` key 已納入 CC 的 `syncUpload()` 自動同步範圍。

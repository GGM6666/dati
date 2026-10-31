/* =========================================================
 * 答题助手 content script
 * 功能：悬浮窗 / 题目识别 / 题库匹配 / 答案高亮 /
 *       手动录入 / 本地搜索 / 强制解除复制限制
 * ========================================================= */
(function () {
  "use strict";

  if (window.__qbHelperLoaded) return;
  window.__qbHelperLoaded = true;

  /* 是否顶层窗口：iframe 内不建悬浮窗，只做识别 / 高亮 / 自动勾选，
     结果通过 postMessage 汇总给顶层悬浮窗 */
  const IS_TOP = (() => {
    try { return window.top === window; } catch (e) { return false; }
  })();

  /* ---------------------------------------------------------
   * 0. 强制解除 复制 / 选取 / 右键 限制
   * --------------------------------------------------------- */
  function forceEnableCopy() {
    // 只拦截"禁止复制"相关的 4 个事件。
    // 重要：不能拦截 mousedown / mouseup / keydown —— 那会让页面挂在 document
    // 上的事件委托全部失效（React 17+ 根容器、下拉框、自定义选项），
    // 表现为点击选项页面没反应、快捷键失灵。
    const events = ["copy", "cut", "contextmenu", "selectstart"];
    const killer = function (e) {
      // 放行插件悬浮窗内部的事件，否则拖拽、输入等会被自己拦截
      const t = e.target;
      if (t && t.closest && t.closest("#qb-helper-panel")) return;
      e.stopPropagation(); // 捕获阶段拦截网页自身的禁用逻辑
    };
    events.forEach((t) => window.addEventListener(t, killer, true));

    // 清除常见的禁止属性（页面动态插入的也一起清）
    const cleanAttrs = () => {
      document.querySelectorAll("[oncopy],[oncut],[oncontextmenu],[onselectstart]").forEach((el) => {
        el.removeAttribute("oncopy");
        el.removeAttribute("oncut");
        el.removeAttribute("oncontextmenu");
        el.removeAttribute("onselectstart");
      });
      document.oncontextmenu = null;
      document.onselectstart = null;
      document.oncopy = null;
    };
    cleanAttrs();
    window.__qbCleanAttrs = cleanAttrs;
    // 覆盖全站 user-select:none 的那三条规则在 content.css 里（见该文件顶部注释）：
    // 走 manifest 声明注入，不受页面 CSP 限制。
  }
  forceEnableCopy();

  /* ---------------------------------------------------------
   * 1. 存储读写
   * --------------------------------------------------------- */
  const DEFAULTS = {
    qb_questions: [],          // 本地题库（手动录入 + 导入）
    qb_remote_questions: [],   // 远程题库（从链接加载）
    qb_threshold: 70,
    qb_selectors: "",
    qb_panel_visible: true,    // 悬浮窗显示开关（popup 控制）
    qb_panel_pos: null,        // 悬浮窗位置 / 尺寸（{left,top,width,height}）
    qb_auto_select: true,      // 自动勾选页面选项（popup 开关）
    qb_auto_fill_blank: true,  // 填空题自动填值（popup 开关）
    // 注意：这个对象同时是"要读哪些键"的清单（storage.local.get(DEFAULTS)），
    // 漏写某个键，读出来的配置就是 undefined —— 上面那些键一个都不能少。
  };

  // storage 读写失败时 chrome.runtime.lastError 才有值；测试环境没有 chrome.runtime，需要兜底
  function lastErr() {
    try { return (chrome.runtime && chrome.runtime.lastError) || null; } catch (e) { return null; }
  }

  /* 题库快照缓存：refresh 由 MutationObserver 频繁触发，每次都 chrome.storage.local.get
     会把整个题库（几千条题干文本）跨进程反序列化一遍，是页面卡顿的主要来源之一。
     改为内存缓存 + 自己写入/onChanged 时失效。 */
  let dataCache = null;
  let bankVersion = 0;            // 题库版本号：变化时作废索引与匹配缓存
  let bankIndexCache = null;      // { version, index }
  const matchCache = new Map();   // 归一化题干 → { item, score }

  function loadData(force) {
    if (!force && dataCache) return Promise.resolve(dataCache);
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(DEFAULTS, (data) => {
        const err = lastErr();
        if (err) { reject(new Error(err.message)); return; }
        dataCache = data;
        // 真正重读过 storage，就把由它派生的索引 / 匹配缓存一起作废，
        // 否则强制刷新后还会用旧题库的索引去匹配（表现为改了题库但结果不变）
        bankVersion++;
        bankIndexCache = null;
        matchCache.clear();
        resolve(data);
      });
    });
  }
  function invalidateData() {
    dataCache = null;
    bankVersion++;
    bankIndexCache = null;
    matchCache.clear();
  }
  function saveQuestions(list) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ qb_questions: list }, () => {
        const err = lastErr();
        if (err) { reject(new Error(err.message)); return; }
        invalidateData();
        resolve();
      });
    });
  }

  /* ---------------------------------------------------------
   * 2. 文本相似度（二元语法 Dice 系数 + 包含关系）
   * --------------------------------------------------------- */
  function normalize(s) {
    return (s || "")
      // 全角 ASCII 转半角：题号 "１." 和选项 "Ａ." 在中文题库里很常见，不转就匹配不上正则
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, ""); // 去空白与标点
  }
  function bigrams(s) {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) || 0) + 1);
    }
    return set;
  }
  // 核心比对：入参均为已归一化字符串，ga/gb 为两侧二元组（调用方可预计算）
  function simN(na, ga, nb, gb) {
    if (!na || !nb) return 0;
    if (na === nb) return 100;
    // 包含关系：题干被包含时给高分，但公共部分必须够长。
    // 原来不管多短都给"保底 70~100"，而 70 就是默认阈值 ——
    // 页面上抽到的短题干（"简答题：TCP协议"）只要被题库任一长题干包含就直接 78 分命中，
    // 于是勾了另一道题的答案。现在：公共部分 < 10 字不算包含，且分数随长度比上升
    // （10/40 → 65 分，低于默认阈值；0.6 → 79；0.9 → 91）。
    const short = Math.min(na.length, nb.length);
    if (short >= 10 && (na.includes(nb) || nb.includes(na))) {
      const ratio = short / Math.max(na.length, nb.length);
      return Math.round(55 + 40 * ratio);
    }
    let hit = 0;
    ga.forEach((cnt, g) => {
      if (gb.has(g)) hit += Math.min(cnt, gb.get(g));
    });
    const total = (na.length - 1) + (nb.length - 1);
    if (total <= 0) return 0;
    return Math.round((2 * hit / total) * 100);
  }
  function simCore(na, nb, gb) {
    return simN(na, bigrams(na), nb, gb);
  }
  function similarity(a, b) {
    const nb = normalize(b);
    return simCore(normalize(a), nb, bigrams(nb));
  }
  // 预建题库索引：题库只归一化/切一次二元组，
  // 避免每道题都对整个题库重新做 normalize + bigrams（原来最耗时的部分）
  // 同一题干（归一化后完全相同）只保留一条，后出现的覆盖前面的答案：
  // bank 为 远程.concat(本地)，因此本地重新录入的修正答案会覆盖远程旧答案，无需先上传；
  // 同时也避免了重复题干在分数相同时被旧答案“抢走”的问题。
  function buildIndex(bank) {
    const byStem = new Map();
    const index = [];
    bank.forEach((item) => {
      if (!item || typeof item.q !== "string") return;
      const nq = normalize(item.q);
      if (!nq) return;
      const prev = byStem.get(nq);
      if (prev) {
        if (typeof item.a === "string" && item.a.trim()) prev.item = item; // 空答案不覆盖
        return;
      }
      const entry = { item, nq, nqBig: bigrams(nq) };
      byStem.set(nq, entry);
      index.push(entry);
    });
    return index;
  }

  // 题库索引缓存：题库没变时直接复用（原来每次 refresh 都要把整个题库重新 normalize + 切二元组）
  function getIndex(bank) {
    if (bankIndexCache && bankIndexCache.version === bankVersion) return bankIndexCache.index;
    const index = buildIndex(bank);
    bankIndexCache = { version: bankVersion, index };
    return index;
  }

  // 单题匹配 + 结果缓存：页面上同一道题在多次 refresh 之间几乎不会变，
  // 大题库（题数 × 题库数）的重复计算可以直接省掉。
  function matchQuestion(index, threshold, nStem, nRaw) {
    const key = threshold + "\u0000" + nStem + "\u0000" + nRaw;
    const hit = matchCache.get(key);
    if (hit) return hit;

    const gStem = bigrams(nStem);
    const gRaw = bigrams(nRaw);
    let best = null, bestScore = 0;
    for (const e of index) {
      let score = simN(nStem, gStem, e.nq, e.nqBig);
      if (score < threshold) {
        // 题干抽取不完整时用整段原文兜底（已达标就不再算，省一半开销）
        const fallback = Math.round(simN(nRaw, gRaw, e.nq, e.nqBig) * 0.9);
        if (fallback > score) score = fallback;
      }
      if (score > bestScore) { bestScore = score; best = e.item; }
    }
    const res = { item: best, score: bestScore };
    if (matchCache.size >= 800) matchCache.clear(); // 换页 / 换题库时避免无限增长
    matchCache.set(key, res);
    return res;
  }

  /* ---------------------------------------------------------
   * 3. 页面题目识别
   *    策略：找到以 “1.” “1、” “第1题” 等开头的锚点元素，
   *    向上扩展到包含选项(A./B.)的容器，拆出题干与选项。
   * --------------------------------------------------------- */
  // \d{1,4}：题号最多支持到 4 位（原来 {1,3}，"1234. xxx" 这种长题号直接认不出来）。
  // 末尾的 (?!\d) 保证 "3.5万" 这类小数不会被当成题号。
  const Q_START = /^\s*(?:第\s*\d+\s*题|\(?\d{1,4}\)?\s*[.、．\)）:：](?!\d))/;
  const CANDIDATE_SEL = "p,div,li,td,section,article,span,h1,h2,h3,h4,h5,h6,label";

  /* 按 A、B、C… 顺序切分选项标记。
     两个约束避免误切：
       ① 字母前不能紧贴字母数字（"Java A." 之类不算，中文/标点/空格前才算）；
       ② 序号必须递增，且必须从 A 开始 —— 选项文字里的 "维生素C." 不会被当成分隔符。
     返回 [{letter, start, end}]，没找到返回空数组。 */
  function splitOptionMarks(raw) {
    const re = /(?<![A-Za-z0-9])([A-G])\s*[.、．\)）:：]/g;
    const marks = [];
    let expected = 0; // 下一个应该出现的选项序号（0=A）
    let m;
    while ((m = re.exec(raw))) {
      const code = m[1].charCodeAt(0) - 65;
      if (code !== expected) continue; // 不连续：当正文，不切
      expected++;
      marks.push({ letter: m[1], start: m.index, end: re.lastIndex });
    }
    return marks;
  }

  // 从纯文本题干里重建选项表。题库存的只是 "题干 A. x B. y" 这一整串文本，
  // 本地搜索结果没有对应的页面容器，直接给 answerHtml 传 null 的话，
  // "ABD" 这类答案只能渲染成孤零零的 "A." / "B." / "D."，得靠它补上选项文字。
  function optionsFromText(rawText) {
    const raw = (rawText || "").replace(/\s+/g, " ").trim();
    const marks = splitOptionMarks(raw);
    if (marks.length < 2) return [];
    return marks.map((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : raw.length;
      return { letter: mk.letter, text: raw.slice(mk.end, end).trim().slice(0, 300) };
    });
  }

  /* 单次扫描内的文本度量缓存。
     向上扩展时会反复对同一批祖先元素算 textContent 长度、innerText 行数，
     而 innerText 会强制同步布局（每个锚点最多 4 次），在长页面上非常贵。
     用 WeakMap 按元素缓存，一次扫描里每个元素只真正计算一次。 */
  let scanLen = null;      // WeakMap<Element, number>
  let scanStarts = null;   // WeakMap<Element, number>

  function textLen(el) {
    if (scanLen) {
      const v = scanLen.get(el);
      if (v !== undefined) return v;
    }
    const len = (el.textContent || "").replace(/\s+/g, "").length;
    if (scanLen) scanLen.set(el, len);
    return len;
  }

  // 统计元素内"新题目"的行数：用于防止向上扩展时把下一道题一起吞掉
  // （必须用 innerText 才有换行信息，textContent 拿不到行边界，所以这里靠缓存控成本）
  function countQuestionStarts(el) {
    if (scanStarts) {
      const v = scanStarts.get(el);
      if (v !== undefined) return v;
    }
    let n = 0;
    if (textLen(el) >= 10) { // 太短的容器不可能装两道题，直接跳过 innerText
      const raw = el.innerText || el.textContent || "";
      n = raw.split(/\n+/).filter((line) => Q_START.test(line.trim())).length;
    }
    if (scanStarts) scanStarts.set(el, n);
    return n;
  }

  function findQuestionContainers(customSelectors) {
    if (!document.body) return [];
    scanLen = new WeakMap();
    scanStarts = new WeakMap();
    try {
      return scanContainers(customSelectors);
    } finally {
      scanLen = null;
      scanStarts = null;
    }
  }

  function scanContainers(customSelectors) {
    const containers = [];
    if (textLen(document.body) < 20) return []; // 空白页 / 小广告框架直接跳过

    /* --- 1. 自定义选择器优先识别（针对特殊网页结构） --- */
    if (customSelectors) {
      customSelectors.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean).forEach((sel) => {
        let nodes;
        try { nodes = document.querySelectorAll(sel); } catch (e) { return; } // 忽略非法选择器
        nodes.forEach((el) => {
          if (el.closest("#qb-helper-panel")) return;
          if ((el.textContent || "").trim().length < 4) return;
          // 去重：已包含/被包含的跳过
          if (containers.some((c) => c.contains(el) || el.contains(c))) return;
          containers.push(el);
        });
      });
    }

    /* --- 2. 启发式识别（题号锚点 + 向上扩展到选项容器） --- */
    const anchors = [];
    // 包裹层的 textContent 也以 "1." 开头（第一道题的题号），
    // 不排除的话它会抢在题干前面成为锚点，把整页题目吞成"1 道题"，
    // 表现就是只认到一道题、后面的题既不匹配也不勾选。
    const hasInnerQuestionStart = (el) => {
      if (!el.childElementCount) return false;
      const kids = el.querySelectorAll(CANDIDATE_SEL);
      for (const k of kids) {
        const len = textLen(k);
        if (len < 8 || len > 400) continue; // 和锚点判定的长度门槛保持一致
        const first = k.firstChild;
        const t = (first && first.nodeType === 3 ? first.nodeValue || "" : k.textContent || "").trim();
        if (Q_START.test(t)) return true;
      }
      return false;
    };
    const candidates = document.querySelectorAll(CANDIDATE_SEL);
    candidates.forEach((el) => {
      if (el.closest("#qb-helper-panel")) return; // 忽略自身悬浮窗
      if (el.childElementCount > 30) return;      // 大包裹层不可能直接是题干，先跳过（省去 textContent 开销）
      if (containers.length && containers.some((c) => c.contains(el))) return; // 已被自定义选择器覆盖
      // 大多数题干的首个子节点就是文本节点，先只取它做正则预筛，
      // 命中不了再退回整棵子树 textContent（大 SPA 上能省掉大量全量文本拼接）
      const first = el.firstChild;
      let t;
      if (first && first.nodeType === 3 && (first.nodeValue || "").trim().length >= 8) {
        t = first.nodeValue.trim();
        if (t.length > 400) return;
        if (!Q_START.test(t)) return;
      } else {
        t = (el.textContent || "").trim();
        if (t.length < 8 || t.length > 400) return;
        if (!Q_START.test(t)) return;
      }
      if (hasInnerQuestionStart(el)) return;      // 里面还装着别的题号 → 是包裹层，不是单题
      // 避免父子重复：其祖先已是锚点则跳过
      if (anchors.length && anchors.some((a) => a.contains(el))) return;
      anchors.push(el);
    });

    anchors.forEach((anchor) => {
      let container = anchor;
      // 向上扩展直到容器里出现至少 2 个选项标记
      for (let i = 0; i < 4 && container.parentElement; i++) {
        const text = container.textContent || "";
        const matches = text.match(/[A-G]\s*[.、．\)）]/g) || [];
        if (matches.length >= 2) break;
        const parent = container.parentElement;
        // 兜底：爬到 body / html 之前必须停。
        // 页面只识别出一道题时，上面三个条件一个都不成立，容器会一路爬到 <html>：
        // 题干会取到整页第一行（页面标题）导致相似度归零，填空题还会顺着 <html>
        // 找到页面顶部的搜索框，把答案写进去而真正的答题框留空。
        if (!parent || parent === document.body || parent === document.documentElement) break;
        if (textLen(parent) > 1500) break;              // 太大，不是单题容器
        if (countQuestionStarts(parent) > 1) break;      // 会吞掉后面的题，停止扩展
        container = parent;
      }

      // ---- 去重：新容器与已有容器的包含关系 ----
      // ① 新容器落在某个已有容器内部
      const outerIdx = containers.findIndex((c) => c.contains(container));
      if (outerIdx >= 0) {
        // 外层只含这一道题时，收紧到内层（内层更精确）；否则保留外层，避免丢题
        if (countQuestionStarts(containers[outerIdx]) <= 1) containers[outerIdx] = container;
        return;
      }
      // ② 新容器把已有容器包住了（向上扩展过头）
      const swallowed = [];
      containers.forEach((c, i) => { if (container.contains(c)) swallowed.push(i); });
      if (swallowed.length) {
        // 只有"确实只装一道题"时才用它替换，否则整个丢弃，防止一次吞掉多题
        if (swallowed.length === 1 && countQuestionStarts(container) <= 1) {
          containers.splice(swallowed[0], 1);
          containers.push(container);
        }
        return;
      }
      containers.push(container);
    });

    // 按文档顺序排列（自定义 + 启发式混合后保证题号正确）
    containers.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );

    // 解析每道题
    return containers.map((container, idx) => {
      const raw = (container.innerText || container.textContent || "").replace(/\s+/g, " ").trim();
      // 按选项标记切分（要求 A→B→C 连续，单标记不算选项）
      const marks = splitOptionMarks(raw);
      // 没有字母标记时（选项是 checkbox / 纯文字列表），题干取"容器文本去掉选项文本"：
      // 直接拿整个容器的文本会把选项文字也带进题干，匹配度被稀释（实测掉到 60 分以下）。
      // 两条路子取较短者：① innerText 第一行（真实浏览器里最准）；② 按第一个选项文字截断。
      // 注意 jsdom 没有 innerText，必须保留 ② 作为兜底（测试环境靠它）。
      const cutByOption = () => {
        const opts = [];
        container.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((inp) => {
          const t = ((inp.closest("label") || inp.parentElement || {}).textContent || "")
            .replace(/\s+/g, " ").trim();
          if (t) opts.push(t);
        });
        if (!opts.length) return "";
        const at = raw.indexOf(opts[0]);
        return at > 0 ? raw.slice(0, at).trim() : "";
      };
      const lineStem = () => {
        const first = (container.innerText || "").split(/\n+/).map((s) => s.trim()).filter(Boolean)[0] || "";
        return first && raw.startsWith(first) ? first : "";
      };
      let stem = raw;
      if (marks.length >= 2) {
        stem = raw.slice(0, marks[0].start);
      } else {
        const a = lineStem(), b = cutByOption();
        if (a && b) stem = a.length <= b.length ? a : b;
        else stem = a || b || raw;
      }
      const options = [];
      if (marks.length >= 2) {
        marks.forEach((mk, i) => {
          const end = i + 1 < marks.length ? marks[i + 1].start : raw.length;
          options.push({ letter: mk.letter, text: raw.slice(mk.end, end).trim().slice(0, 300) });
        });
      }
      // 选项没有 "A." 字母前缀时（常见于多选题）：从 radio/checkbox 生成伪选项
      // 按控件顺序对应 A/B/C/...，文字取 label 或父元素文本
      if (!options.length) {
        const LETTERS = "ABCDEFG";
        const inputs = container.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        inputs.forEach((inp, i) => {
          if (i >= LETTERS.length) return;
          const scope = inp.closest("label") || inp.parentElement;
          const t = (scope.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.length <= 200) options.push({ letter: LETTERS[i], text: t });
        });
      }
      // 题干去掉开头题号
      // 位数与哨兵正则 Q_START 保持一致，否则四位题号会留在题干里拉低相似度
      stem = stem.replace(/^\s*(?:第\s*\d+\s*题|\(?\d{1,4}\)?\s*[.、．\)）:：](?!\d))\s*/, "").trim();
      return { index: idx + 1, container, stem, options, raw };
    }).filter((q) => q.stem.length >= 4);
  }

  /* ---------------------------------------------------------
   * 4. 答案高亮
   *    两种标记方式：
   *    ① 整段文本就是一个节点 → 给它的父元素加 class，完全不动 DOM 结构
   *    ② 只有一部分命中 → 用 span 包住命中的片段
   *    两种都不用 parent.normalize()。
   * --------------------------------------------------------- */
  const classMarks = new Set(); // 用 class 标记过的元素（② 方式的 span 不在此列）

  function unwrapHighlight(span) {
    const parent = span.parentNode;
    if (!parent) return;
    // 只把 span 的子节点挪回原位。绝对不能调用 parent.normalize()：
    // 它会把页面自己的 Text 节点合并/删掉，React / Vue 持有的节点引用随之失效，
    // 之后框架 removeChild 会抛 NotFoundError（表现为点击选项整页卡死、白屏）。
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }

  function clearHighlights() {
    document.querySelectorAll("span.qb-highlight[data-qb-hl]").forEach(unwrapHighlight);
    classMarks.forEach((el) => {
      if (el.isConnected) el.classList.remove("qb-highlight");
    });
    classMarks.clear();
  }

  /* ---------------------------------------------------------
   * 3.5 题型识别 / 答案字母解析 / 自动勾选
   * --------------------------------------------------------- */
  // 单选 single / 多选 multi / 填空 blank
  function detectType(q) {
    if (/(多选|多项选择|不定项)/.test(q.raw)) return "multi";
    // checkbox 判断要在"无选项判填空"之前：多选题选项常无字母前缀，但有 checkbox
    if (q.container.querySelectorAll('input[type="checkbox"]').length >= 2) return "multi";
    if (q.options.length === 0) {
      // 选项文本没切出来（自定义控件、选项里带图片、字母前缀不是 A.），但容器里明明有
      // 单选/复选控件 —— 那它就是选择题，按 single 交给字母点击处理。
      // 原来一律判成填空题：遇到"题干 + 输入框 + 选项"的组合题，答案会被写进旁边的输入框。
      if (q.container.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]').length) {
        return "single";
      }
      return "blank";
    }
    return "single";
  }

  // 从答案中解析选项字母（A~G），支持：
  //   "B"、"B. 北京"、"B 北京"、"ABD"、"A’B’D"、"A、B、D"、"A,B,D"、"A B D"
  // 纯文字答案不会被误判：紧跟英文字母时视为单词（"CSS"、"Excel"、"HTML"）
  function parseAnswerLetters(answer) {
    const t = (answer || "").trim().toUpperCase();
    const m = t.match(/^[A-G](?:[\s、,，+&/’'‘]*[A-G])*/);
    if (!m) return [];
    const run = m[0].replace(/[^A-G]/g, "");
    if (!run) return [];
    const rest = t.slice(m[0].length);
    if (/^[A-Z]/.test(rest)) return []; // CSS / Excel 等单词，不是选项字母
    return run.split("");
  }

  /* 判断题：题库里 √ / × / 对 / 错 / 正确 / 错误 / T / F 写法五花八门，
     统一映射成「对 / 错」，再用同义词去反查页面上的选项文字。
     注意不收单字母 T / F / Y / N —— 会和选项字母 F 撞车。 */
  const JUDGE_MAP = {
    "√": "对", "✓": "对", "✔": "对", "对": "对", "正确": "对", "是": "对",
    "true": "对", "right": "对", "yes": "对",
    "×": "错", "✗": "错", "✘": "错", "✕": "错", "错": "错", "错误": "错", "否": "错",
    "false": "错", "wrong": "错", "no": "错",
  };
  const JUDGE_ALIAS = {
    "对": ["对", "正确", "是", "√", "✓", "✔", "true", "right", "yes"],
    "错": ["错", "错误", "否", "×", "✗", "✘", "✕", "false", "wrong", "no"],
  };
  function judgeToken(part) {
    const t = (part || "").trim().toLowerCase();
    return t ? (JUDGE_MAP[t] || null) : null;
  }
  function mapJudgePart(p) {
    return judgeToken(p) || p;
  }

  /* --- 判断题符号证据：从"没有文字"的选项里推断对 / 错 ---
     很多站点的 ✓ / ✗ 不是文本，而是 icon 字体（伪元素 content）、图片 alt、
     svg 或 class 名 —— textContent 里什么都搜不到，答案就没法对号入座。
     这里按两层证据判断一个选项单元的"立场"：
       强证据：选项文本（短文本才采信）、value / title / aria-label / alt / data-* 属性、
               自身与子孙元素的 ::before / ::after content
       弱证据：class 名（icon-dui / icon-cuowu 之类）                             */
  const JUDGE_YES_RE = /对|正确|是|√|✓|✔|true|yes|right|correct|dui|check/i;
  const JUDGE_NO_RE = /错|错误|否|×|✗|✘|✕|false|no\b|wrong|error|cross|close|cuo|fail/i;
  // class 里的选中状态（checked / selected / is-active…）不是对错语义，
  // 不剔除的话选项一旦被勾上，class tier 会把它误判成"对"
  const JUDGE_STATE_CLASS_RE = /[\w-]*(checked|selected|active|current)[\w-]*/gi;

  function elClass(el) {
    // SVG 元素的 className 是 SVGAnimatedString，要取 baseVal
    const c = el.className;
    return typeof c === "string" ? c : (c && c.baseVal) || "";
  }

  function pseudoContent(el) {
    let s = "";
    try {
      s += String(getComputedStyle(el, "::before").content || "");
      s += String(getComputedStyle(el, "::after").content || "");
    } catch (e) { /* 测试环境没有 getComputedStyle */ }
    return s;
  }

  function judgeAttrs(el) {
    let s = "";
    if (!el.getAttribute) return s;
    ["title", "alt", "aria-label", "value"].forEach((a) => {
      const v = el.getAttribute(a);
      if (v) s += " " + v;
    });
    // data-* 里常存 true / false 或 对 / 错（自定义控件）
    const attrs = el.attributes || [];
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.name.indexOf("data-") === 0 && a.value && a.value.length <= 20) s += " " + a.value;
    }
    return s;
  }

  // 返回 "对" / "错" / null（证据不足或两边都有证据）
  function judgeSideOf(scope) {
    if (!scope || scope.nodeType !== 1) return null;
    let strong = pseudoContent(scope) + judgeAttrs(scope);
    let weak = " " + elClass(scope) + " ";
    const kids = scope.querySelectorAll("*");
    for (let i = 0; i < kids.length && i < 20; i++) {
      strong += judgeAttrs(kids[i]) + pseudoContent(kids[i]);
      weak += " " + elClass(kids[i]) + " ";
    }
    // 文本只在短文本时采信：判断题选项几乎没文字，
    // 长文本里的"是否""正确"会造成误判
    const txt = (scope.textContent || "").replace(/\s+/g, " ").trim();
    if (txt && txt.length <= 8) strong += " " + txt + " ";
    const yS = JUDGE_YES_RE.test(strong), nS = JUDGE_NO_RE.test(strong);
    if (yS !== nS) return yS ? "对" : "错"; // 恰好一边有证据
    weak = weak.replace(JUDGE_STATE_CLASS_RE, " ");
    const yW = JUDGE_YES_RE.test(weak), nW = JUDGE_NO_RE.test(weak);
    if (yW !== nW) return yW ? "对" : "错";
    return null;
  }

  // 判断题兜底：按"对 / 错"立场找选项元素（优先真实控件，其次 A./B. 文字标记的选项行）
  function findJudgeOptionEl(question, side) {
    if (!question || !question.container || !side) return null;
    const units = [];
    const inputs = question.container.querySelectorAll(
      'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
    if (inputs.length) {
      inputs.forEach((input) => {
        units.push({ el: input, scope: input.closest("label") || input.parentElement });
      });
    } else if (question.options && question.options.length >= 2) {
      // 连真实控件都没有的自定义选项：按 A. / B. 标记找选项行，
      // 取最外层的短文本元素（行内包含该选项的全部内容，符号证据在这里）
      question.options.forEach((opt) => {
        if (!opt || !opt.letter) return;
        const re = new RegExp("^\\s*" + opt.letter + "\\s*[.、．\\)）:：]");
        const els = Array.from(question.container.querySelectorAll("*")).filter((el) => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!t || t.length > 12 || el.children.length > 6) return false;
          return re.test(t);
        });
        if (els.length) units.push({ el: els[0], scope: els[0] });
      });
    }
    const hit = units.find((u) => judgeSideOf(u.scope) === side);
    return hit ? hit.el : null;
  }

  // 把答案拆成多个独立部分：
  // "A’B’D" → ["A","B","D"]；"选项文字1’选项文字2" → ["选项文字1","选项文字2"]
  // 另外兼容"多个选项被拼进答案"的脏数据：
  // "发展性 B. 科学性 C. 人民性" → ["发展性","科学性","人民性"]
  // 无分隔符时原样返回单元素数组（"ABD"、"B. 北京"、"五星红旗"）
  // 判断题符号（√ / ×）会先归一成「对 / 错」
  function splitAnswerParts(answer) {
    const t = (answer || "").trim();
    if (!t) return [];
    const parts = t.split(/[’'‘]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts.map(mapJudgePart);
    // 单个片段里出现 ≥2 个 "A." 标记，说明是多个选项被拼接（题库导入常见脏数据）
    const marks = t.match(/[A-G]\s*[.、．\)）:：]/g) || [];
    if (marks.length >= 2) {
      const segs = t.split(/[A-G]\s*[.、．\)）:：]/).map((s) => s.trim()).filter(Boolean);
      if (segs.length >= 2) return segs.map(mapJudgePart);
    }
    return [mapJudgePart(t)];
  }

  // 勾选/填空的具体执行在下方"自动勾选队列"一节（applyAnswer / doFillBlank）

  // 点击选项控件。返回 true 表示"已确认选中"。
  // 只调用 input.click() 在不少站点上无效（选项被 label / li 接管、input 是隐藏元素），
  // 所以点完要校验 checked，没生效再点一次外层容器。
  // 自定义控件（div[role=radio] 等）没有 checked：按 aria-checked 校验，
  // 两者都没有时视为已点中（否则会永远重试失败）。
  function clickOption(input) {
    if (!input) return false;
    const isChecked = () => {
      if (typeof input.checked === "boolean") return input.checked;
      const a = input.getAttribute ? input.getAttribute("aria-checked") : null;
      if (a === "true") return true;
      if (a === "false") return false;
      return null; // 没有可校验的选中状态
    };
    if (isChecked() === true) return true;
    const fire = (el) => { try { el.click(); } catch (e) { /* 页面拦截了 click，交给外层兜底 */ } };
    fire(input);
    if (isChecked() === true) return true;
    const scope = input.closest("label") || input.parentElement;
    if (scope && scope !== input) fire(scope);
    return isChecked() !== false;
  }

  // 填空题：用原生 value setter + 派发 input/change，React 受控组件才认得这次修改
  function setInputValue(inp, value) {
    const proto = inp.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(inp, value);
      else inp.value = value;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }

  // 填空题：把答案写进文本输入框（支持多个空：答案用 ’ 分隔时依次填入）
  // 注意用原始答案，不走 splitAnswerParts：填空题的答案本来就是纯文字，
  // 走了会被判断题映射改写（答案 "是" 被改成 "对"）。
  function doFillBlank(question, answer) {
    const value = (answer || "").trim();
    if (!value) return false;
    // 兜底：容器里还有单选/复选控件，说明这是选择题（选项可能用的是自定义控件，
    // 被上面的 detectType 判成了填空）。这时把答案写进旁边的输入框属于误填，宁可不动。
    if (question.container.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) return false;
    // 刚刚因为"其实是选择题"回滚过这道题：短时间内不要再填，否则会在"填空 / 选择"之间来回横跳
    if (isRecentlyReverted(questionKey(question))) return false;
    const inputs = [];
    question.container.querySelectorAll('input[type="text"], input:not([type]), textarea').forEach((inp) => {
      if (inp.disabled || inp.readOnly) return;
      if (inp.value && inp.value.trim()) return; // 已经有内容就不覆盖
      inputs.push(inp);
    });
    if (!inputs.length) return false;
    let values = [value];
    // 多个空 + 答案用 ’ 分成多段 → 一空一段（原来整串连分隔符都塞进第一个框）
    if (inputs.length > 1) {
      const parts = value.split(/[’'‘]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1 && parts.length <= inputs.length) values = parts;
    }
    // 只有值还是我们写的那个才回滚，用户自己改过的不动
    let filled = 0;
    const key = questionKey(question);
    values.forEach((v, i) => {
      if (inputs[i] && setInputValue(inputs[i], v)) {
        fillRecords.push({ input: inputs[i], key, prev: "", text: v });
        filled++;
      }
    });
    return filled > 0;
  }

  // 插件填过值的输入框记录：key（题干）+ 元素 + 填之前的值。
  // 场景：页面晚一步才渲染出选项，上一轮被当成填空题填了值，这一轮认清是选择题后要把值撤回去，
  // 否则一道选择题的答案会孤零零留在旁边的输入框里跟着被提交。
  const fillRecords = [];
  const revertedKeys = new Map(); // 题干 key → 上次回滚时间（30s 内不再对这道题自动填空）
  const REVERT_TTL = 30 * 1000;
  function isRecentlyReverted(key) {
    const t = revertedKeys.get(key);
    if (t === undefined) return false;
    if (Date.now() - t > REVERT_TTL) { revertedKeys.delete(key); return false; }
    return true;
  }
  // nonBlankKeys：本轮扫描里已经确认不是填空题的题干。填过值但还在里面 → 撤回。
  function revertFills(nonBlankKeys) {
    for (let i = fillRecords.length - 1; i >= 0; i--) {
      const r = fillRecords[i];
      // 输入框已被页面重渲染替换掉：够不着了，丢掉记录
      if (!r.input.isConnected) { fillRecords.splice(i, 1); continue; }
      if (!nonBlankKeys.has(r.key)) continue; // 还是填空题，保留
      if (r.input.value === r.text) setInputValue(r.input, r.prev || "");
      revertedKeys.set(r.key, Date.now());
      fillRecords.splice(i, 1);
    }
  }

  /* --- 自动勾选队列：逐个点击并加随机间隔 ---
   * 学习通等考试页面每点一个选项就可能发一次保存请求，
   * 瞬间点完几十道题会触发网站的"并发限制"弹窗，所以排队慢慢点。
   *
   * 队列里只存题干 key，不存 DOM 节点：页面（React / Vue）在点击后常会整片重建选项节点，
   * 拿着旧节点去 click() 是空操作 —— 旧实现正是这样"点了一下就再也不动了"。
   * 执行时用 findLiveQuestion() 重新定位，点完还要校验 checked，没勾上就重试。 */
  const autoSelectCfg = { minDelay: 400, maxDelay: 800, retryDelay: 1200, maxTries: 3 }; // 毫秒（测试时可调小）
  const selectQueue = [];
  const selectDone = new Set();    // 已确认勾选成功的题干
  const selectQueued = new Set();  // 已排队（防止同一道题重复入队）
  const selectFailed = new Set();  // 重试后仍未勾上的题干（给用户提示）
  const selectTries = new Map();   // 题干 → 已尝试次数
  let dbgBankSize = 0; // 最近一次构建的题库索引条数（同题干已归并）
  let selectTimer = null;
  let lastScan = { at: 0, list: [] }; // 最近一次扫描结果，供 DOM 重建后重新定位

  function questionKey(question) {
    return question.selKey || normalize(question.stem) || String(question.index);
  }

  // 按题干 key 找到"还活在页面里"的那道题。
  // 上次扫描拿到的节点被框架换掉时，重扫一次再找（最多每 600ms 一次，避免拖慢页面）。
  function findLiveQuestion(key) {
    const pick = (list) => list.find((q) => q.selKey === key && q.container && q.container.isConnected) || null;
    const hit = pick(lastScan.list);
    if (hit) return hit;
    if (Date.now() - lastScan.at > 600) {
      try {
        const list = findQuestionContainers((dataCache && dataCache.qb_selectors) || "");
        list.forEach((q) => { q.selKey = normalize(q.stem); });
        lastScan = { at: Date.now(), list };
        return pick(list);
      } catch (e) { return null; }
    }
    return null;
  }

  // 把答案应用到页面上；返回 true 表示每个选项都已确认勾选
  function applyAnswer(key, answer) {
    let allOk = true;
    splitAnswerParts(answer).forEach((part) => {
      const letters = parseAnswerLetters(part);
      if (letters.length) {
        // 字母形式：B / ABD。每个字母前都重新定位一次容器（上一个点击可能触发了重渲染）
        letters.forEach((letter) => {
          const q = findLiveQuestion(key);
          if (!q) { allOk = false; return; }
          let input = q.options.length ? findOptionInput(q, letter) : null;
          // 兜底：按字母序号映射第 N 个控件（A→第1个，B→第2个…）
          if (!input) {
            const inputs = q.container.querySelectorAll('input[type="radio"], input[type="checkbox"]');
            const idx = letter.charCodeAt(0) - 65;
            if (idx >= 0 && idx < inputs.length) input = inputs[idx];
          }
          if (!clickOption(input)) allOk = false;
        });
      } else {
        // 文字形式：按选项文字内容匹配控件
        const q = findLiveQuestion(key);
        let input = q ? findOptionInputByText(q, part) : null;
        // 判断题兜底：选项没有文字（只有 ✓/✗ 图标）时，按符号证据定位对 / 错
        if (q && !input) {
          const side = judgeToken(part);
          if (side) input = findJudgeOptionEl(q, side);
        }
        if (!q || !clickOption(input)) allOk = false;
      }
    });
    return allOk;
  }

  function queueSelect(question, answer) {
    const key = questionKey(question);
    if (!key || selectDone.has(key) || selectQueued.has(key)) return;
    if ((selectTries.get(key) || 0) >= autoSelectCfg.maxTries) return; // 反复失败的不再自动重试
    selectQueued.add(key);
    selectQueue.push({ key, answer });
    scheduleSelect();
  }

  function scheduleSelect(forceDelay) {
    if (selectTimer || !selectQueue.length) return;
    const head = selectQueue[0];
    // 重试的任务带 notBefore：选项还没渲染出来时不能马上重试，隔一会儿再来
    const wait = Math.max(0, (head.notBefore || 0) - Date.now());
    const base = typeof forceDelay === "number" ? forceDelay : autoSelectCfg.minDelay +
      Math.floor(Math.random() * (autoSelectCfg.maxDelay - autoSelectCfg.minDelay));
    selectTimer = setTimeout(runSelect, Math.max(base, wait));
  }

  function runSelect() {
    selectTimer = null;
    const job = selectQueue.shift();
    if (job) {
      selectQueued.delete(job.key);
      const tries = (selectTries.get(job.key) || 0) + 1;
      selectTries.set(job.key, tries);
      let ok = false;
      try { ok = applyAnswer(job.key, job.answer); } catch (e) { ok = false; }
      if (ok) {
        selectDone.add(job.key);
        if (selectFailed.delete(job.key)) renderSelectNote();
      } else if (tries < autoSelectCfg.maxTries) {
        // 选项还没渲染出来 / 点了没生效：放回队尾，隔 retryDelay×次数 再试
        job.notBefore = Date.now() + autoSelectCfg.retryDelay * tries;
        selectQueued.add(job.key);
        selectQueue.push(job);
      } else {
        selectFailed.add(job.key);
        renderSelectNote();
      }
    }
    if (selectQueue.length) scheduleSelect();
  }

  // 题库/阈值变化、用户手动重新扫描时才清空队列与"已勾选"记录。
  // 普通 DOM 变化触发的 refresh 绝不能清：页面每点一个选项都会产生变化，
  // 一清队列就从第一题重排，遇到连续变化的页面（进度条/计时器）永远排不完。
  function resetSelectState() {
    selectQueue.length = 0;
    selectDone.clear();
    selectQueued.clear();
    selectFailed.clear();
    selectTries.clear();
    clearTimeout(selectTimer);
    selectTimer = null;
    renderSelectNote();
  }

  // 勾选失败时在列表底部提示（否则用户只看到"没勾上"，不知道可以重试）
  function renderSelectNote() {
    if (!listEl) return;
    const old = listEl.querySelector("#qb-select-note");
    if (old) old.remove();
    if (!selectFailed.size) return;
    if (listEl.querySelector(".qb-search-head")) return; // 搜索结果列表里不插这条
    const div = document.createElement("div");
    div.id = "qb-select-note";
    div.className = "qb-item qb-lowconf";
    div.textContent = `有 ${selectFailed.size} 道题的答案没能勾选上（页面选项可能还没渲染完），点 ⟳ 重新扫描再试`;
    listEl.appendChild(div);
  }

  // 按选项文字内容查找对应控件
  function findOptionInputByText(question, text) {
    const raw = (text || "").trim();
    const key = normalize(raw);
    const judge = JUDGE_ALIAS[raw] || null; // 判断题：对 / 错 → 同义词表
    if (!key && !judge) return null;
    const inputs = question.container.querySelectorAll(
      'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
    for (const input of inputs) {
      const scope = input.closest("label") || input.parentElement;
      const body = (scope.textContent || "").replace(/\s+/g, " ").trim();
      const t = normalize(body);
      if (key && t && (t.includes(key) || (t.length >= 2 && key.includes(t)))) return input;
      if (judge) {
        // 页面选项可能写 "对 / 正确 / 是 / √"，去掉选项字母后按同义词比对
        const opt = body.replace(/^\s*[A-Za-z]\s*[.、．\)）:：]\s*/, "").trim();
        if (opt && judge.some((a) => opt === a || opt.startsWith(a))) return input;
        // ✓/✗ 常被做成 icon 字体 / 图片 / class，textContent 里没有字：
        // 改从选项单元的文本、属性、伪元素 content、class 里找"对 / 错"证据
        if (judgeSideOf(scope) === raw) return input;
      }
    }
    return null;
  }

  function findOptionInput(question, letter) {
    const inputs = Array.from(
      question.container.querySelectorAll('input[type="radio"], input[type="checkbox"]')
    );
    if (!inputs.length) return null;
    const opt = question.options.find((o) => o.letter === letter);
    const letterRe = new RegExp("^\\s*" + letter + "\\s*[.、．\\)）:：]");
    for (const input of inputs) {
      // 找包裹该 input 的选项单元（label 或父元素）
      let scope = input.closest("label") || input.parentElement;
      let text = (scope.textContent || "").trim();
      // 范围太大（包含多个选项标记）时，缩小到 input 之后的紧邻文本
      const markers = text.match(/[A-G]\s*[.、．\)）:：]/g) || [];
      if (markers.length > 1) {
        let t2 = "";
        let node = input.nextSibling;
        while (node && t2.length < 60) {
          t2 += node.textContent || "";
          node = node.nextSibling;
        }
        text = t2.trim();
      }
      if (letterRe.test(text)) return input;
      if (opt && opt.text) {
        const optKey = normalize(opt.text).slice(0, 8);
        if (optKey && normalize(text).indexOf(optKey) === 0) return input;
      }
    }
    return null;
  }

  function highlightText(container, targetText) {
    const normTarget = normalize(targetText);
    if (!normTarget) return false;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (!node.parentElement) return NodeFilter.FILTER_REJECT;
        if (node.parentElement.closest("#qb-helper-panel")) return NodeFilter.FILTER_REJECT;
        if (node.parentElement.classList.contains("qb-highlight")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const text = node.nodeValue;
      const normText = normalize(text);
      const pos = normText.indexOf(normTarget);
      if (pos === -1) continue;

      // ① 整段文本正好是这个节点（最常见的选项文字形态）：
      //    给父元素加 class 就够了，完全不拆分文本节点，页面框架感知不到 DOM 变化
      if (pos === 0 && normText.length === normTarget.length && node.parentElement) {
        node.parentElement.classList.add("qb-highlight");
        classMarks.add(node.parentElement);
        return true;
      }

      // ② 只有一部分命中：在原文中找到对应范围（按非标点字符计数映射）
      let count = 0, start = -1, end = -1;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/[\s\p{P}\p{S}]/u.test(ch)) continue;
        if (count === pos && start === -1) start = i;
        if (count === pos + normTarget.length - 1) { end = i + 1; break; }
        count++;
      }
      if (start === -1 || end === -1) continue;

      // 目标是「……（简称京）」这类以标点结尾的文本时，上面只算到最后一个字，
      // 尾括号会留在外面不好看。这里把紧随其后的标点一并包进高亮范围。
      const lastChar = targetText[targetText.length - 1] || "";
      if (/[\s\p{P}\p{S}]/u.test(lastChar)) {
        while (end < text.length && /[\s\p{P}\p{S}]/u.test(text[end])) end++;
      }

      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const span = document.createElement("span");
      span.className = "qb-highlight";
      span.dataset.qbHl = "1"; // 只回收自己插入的 span，不误伤页面同名元素
      try {
        range.surroundContents(span);
        return true;
      } catch (e) { /* 跨节点时忽略 */ }
    }
    return false;
  }

  function highlightAnswer(question, answer) {
    let ok = false;
    splitAnswerParts(answer).forEach((part) => {
      const letters = parseAnswerLetters(part);
      if (letters.length) {
        // 字母形式（"B" / "B. 北京" / "ABD"）：高亮对应选项文字
        if (!question.options.length) return; // 纯字母且无可定位选项，跳过
        letters.forEach((letter) => {
          const opt = question.options.find((o) => o.letter === letter);
          if (opt && highlightText(question.container, opt.text)) ok = true;
        });
      } else {
        // 文字形式（"北京" / 完整选项文字）：直接在题目容器里高亮该文字
        if (highlightText(question.container, part)) {
          ok = true;
        } else if (JUDGE_ALIAS[part]) {
          // 判断题兜底：页面写 "√"，题库写 "对"（或反过来），按同义词再试一轮
          for (const alt of JUDGE_ALIAS[part]) {
            if (highlightText(question.container, alt)) { ok = true; break; }
          }
          // 图标式判断题（✓/✗ 不是文本）：高亮不了文字，直接给选项单元加高亮
          if (!ok) {
            const side = judgeToken(part);
            const el = side && findJudgeOptionEl(question, side);
            if (el) {
              const scope = (el.closest && el.closest("label")) || el.parentElement || el;
              scope.classList.add("qb-highlight");
              classMarks.add(scope);
              ok = true;
            }
          }
        }
      }
    });
    return ok;
  }

  /* ---------------------------------------------------------
   * 5. 悬浮窗 UI
   * --------------------------------------------------------- */
  let panel, listEl, countEl, searchInput;
  let panelCollapsed = false;
  let rectTimer = null;

  // 保存悬浮窗位置与尺寸（拖动结束 / 改变大小后）
  // ResizeObserver 会因列表内容变化频繁触发，这里做一次去重，
  // 尺寸没变就不写 storage（否则每次刷新列表都写一次）
  let lastRectKey = "";
  function savePanelRect() {
    if (!panel || panelCollapsed) return;
    const r = panel.getBoundingClientRect();
    const next = {
      left: Math.round(r.left),
      top: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
    const key = next.left + "," + next.top + "," + next.width + "," + next.height;
    if (key === lastRectKey) return;
    lastRectKey = key;
    chrome.storage.local.set({ qb_panel_pos: next }, () => { void lastErr(); });
  }
  function savePanelRectSoon() {
    clearTimeout(rectTimer);
    rectTimer = setTimeout(savePanelRect, 400);
  }

  const PANEL_DEFAULT = { left: 20, top: 80 };
  // 位置/尺寸钳制：至少留 80×40 在可视区内。
  // 原来只 Math.max(0, left)，把窗口拖到屏幕右侧或被搬到更小的显示器后，
  // 恢复出来的悬浮窗完全在视口外，且没有任何复位入口（只能清 storage）。
  function clampPanelPos(pos) {
    const W = window.innerWidth || 1024;
    const H = window.innerHeight || 768;
    const width = Math.min(Math.max(220, pos.width || 320), Math.max(220, W - 20));
    const height = Math.min(Math.max(120, pos.height || 300), Math.max(120, H - 20));
    return {
      left: Math.min(Math.max(0, pos.left || 0), Math.max(0, W - 80)),
      top: Math.min(Math.max(0, pos.top || 0), Math.max(0, H - 40)),
      width,
      height,
    };
  }

  function createPanel(pos) {
    panel = document.createElement("div");
    panel.id = "qb-helper-panel";
    panel.innerHTML = `
      <div class="qb-header" id="qb-drag">
        <span class="qb-title">📋 答题助手</span>
        <span class="qb-count" id="qb-count" title="当前题库题目数量">题库: 0</span>
        <span class="qb-btn" id="qb-add-toggle" title="手动录入题目">＋录入</span>
        <span class="qb-btn" id="qb-rescan" title="重新扫描页面题目">⟳</span>
        <span class="qb-btn" id="qb-collapse" title="收起/展开">—</span>
      </div>
      <div class="qb-body" id="qb-body">
        <div class="qb-add-form" id="qb-add-form" style="display:none;">
          <textarea id="qb-add-q" placeholder="题目内容" rows="2"></textarea>
          <textarea id="qb-add-a" placeholder="答案：单选填 B 或 选项文字；多选用 ’ 分隔（A’B’D 或 文字1’文字2）；填空直接填文字" rows="2"></textarea>
          <button id="qb-add-save">保存 / 修正答案</button>
        </div>
        <div class="qb-search-row">
          <input id="qb-search-input" placeholder="选中页面文字自动搜题库；也可输入后点本地搜索" />
          <button id="qb-search-fill" title="把当前选中的文字填入">⇩</button>
          <button id="qb-local-go" title="在题库中搜索该内容">本地搜索</button>
        </div>
        <div class="qb-list" id="qb-list"></div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    // 恢复上次的位置与尺寸（越界一律拉回可视区）
    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      const c = clampPanelPos(pos);
      panel.style.left = c.left + "px";
      panel.style.top = c.top + "px";
      panel.style.right = "auto";
      if (pos.width) panel.style.width = c.width + "px";
      if (pos.height) panel.style.height = c.height + "px";
    }

    listEl = panel.querySelector("#qb-list");
    countEl = panel.querySelector("#qb-count");
    searchInput = panel.querySelector("#qb-search-input");

    // 悬浮窗内部的交互不再冒泡给网页，避免触发页面全局快捷键 / 点击处理
    ["mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "input"].forEach((t) =>
      panel.addEventListener(t, (e) => e.stopPropagation())
    );

    // 拖动
    const drag = panel.querySelector("#qb-drag");
    let dragging = false, offX = 0, offY = 0;
    const dragAbort = { current: null };
    drag.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("qb-btn")) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      document.documentElement.classList.add("qb-dragging"); // 拖拽时禁止选中网页文字
      e.preventDefault();
      // 原来 mousemove / mouseup 挂在 window 上从不移除（每次拖动前 mousedown 也不会解绑），
      // 一次拖动就留两个常驻监听。改成用 AbortController 作用域管理，松手即释放。
      if (dragAbort.current) dragAbort.current.abort();
      dragAbort.current = new AbortController();
      const opts = { capture: true, signal: dragAbort.current.signal };
      const movePanel = (ev) => {
        const W = window.innerWidth || 1024;
        const H = window.innerHeight || 768;
        // 上界钳制：允许贴边，但至少留 80×40 在屏幕内，拖出去也能拖回来
        panel.style.left = Math.min(Math.max(0, ev.clientX - offX), Math.max(0, W - 80)) + "px";
        panel.style.top = Math.min(Math.max(0, ev.clientY - offY), Math.max(0, H - 40)) + "px";
        panel.style.right = "auto";
      };
      window.addEventListener("mousemove", movePanel, opts);
      window.addEventListener("mouseup", () => {
        if (!dragging) return;
        window.removeEventListener("mousemove", movePanel, opts);
        dragging = false;
        document.documentElement.classList.remove("qb-dragging");
        savePanelRect();
        if (dragAbort.current) { dragAbort.current.abort(); dragAbort.current = null; }
      }, opts);
    });

    // 双击标题栏：位置复位（找不到悬浮窗时的救命入口）
    drag.addEventListener("dblclick", (e) => {
      if (e.target.classList.contains("qb-btn")) return;
      panel.style.left = PANEL_DEFAULT.left + "px";
      panel.style.top = PANEL_DEFAULT.top + "px";
      panel.style.right = "auto";
      savePanelRect();
    });

    // 窗口尺寸变化后把悬浮窗拉回可视区（换显示器 / 缩小窗口的常见场景）
    window.addEventListener("resize", () => {
      if (!panel || panelCollapsed) return;
      const r = panel.getBoundingClientRect();
      const c = clampPanelPos({ left: r.left, top: r.top, width: r.width, height: r.height });
      panel.style.left = c.left + "px";
      panel.style.top = c.top + "px";
      savePanelRectSoon();
    });

    // 改变大小后持久化（CSS resize: both 不触发事件，用 ResizeObserver 兜底）
    if (window.ResizeObserver) {
      new ResizeObserver(() => savePanelRectSoon()).observe(panel);
    }

    // 收起/展开：收起时整个窗口缩到只剩标题栏，展开时恢复原高度
    let savedHeight = null;
    panel.querySelector("#qb-collapse").addEventListener("click", () => {
      const body = panel.querySelector("#qb-body");
      const btn = panel.querySelector("#qb-collapse");
      if (body.style.display === "none") {
        // 展开：恢复高度与可调大小
        body.style.display = "";
        panel.style.height = (savedHeight || 300) + "px";
        panel.style.minHeight = "";
        panel.style.resize = "";
        btn.textContent = "—";
        panelCollapsed = false;
        savePanelRectSoon();
      } else {
        // 收起：记录当前高度，收缩到标题栏高度
        savedHeight = panel.getBoundingClientRect().height;
        body.style.display = "none";
        panel.style.height = "auto";
        panel.style.minHeight = "0";
        panel.style.resize = "none";
        btn.textContent = "▢";
        panelCollapsed = true;
      }
    });

    // 录入表单开关
    panel.querySelector("#qb-add-toggle").addEventListener("click", () => {
      const f = panel.querySelector("#qb-add-form");
      f.style.display = f.style.display === "none" ? "" : "none";
    });

    // 保存录入（单选：B / B. 北京；多选：A’B’D / ABD；填空：直接填文字）
    panel.querySelector("#qb-add-save").addEventListener("click", async () => {
      const q = panel.querySelector("#qb-add-q").value.trim();
      const a = panel.querySelector("#qb-add-a").value.trim();
      if (!q || !a) { panelMsg("录入失败：题目和答案都不能为空"); return; }
      const data = await loadData(true); // 录入前必须读最新本地题库，不能吃缓存
      // 同题干（归一化后相同）视为同一题：直接替换答案，不重复追加
      const key = normalize(q);
      // 复制一份再改：data.qb_questions 可能就是缓存里的那个数组，直接改会污染缓存
      const list = (data.qb_questions || []).slice();
      const idx = list.findIndex((x) => x && normalize(x.q || "") === key);
      if (idx >= 0) {
        const oldA = list[idx].a;
        list[idx] = { q: list[idx].q, a };
        if (oldA !== a) console.info("[题库] 已修正该题答案：" + oldA + " → " + a);
      } else {
        list.push({ q, a });
      }
      try {
        await saveQuestions(list);
      } catch (e) {
        // 写入失败（存储超限等）必须让用户知道，否则会以为录入成功了
        panelMsg("保存失败：" + escapeHtml(e.message) + "<br><br>本地存储可能已满，请在 popup 里「导出题库」后清理本地题目。");
        return;
      }
      panel.querySelector("#qb-add-q").value = "";
      panel.querySelector("#qb-add-a").value = "";
      resetSelectState();
      refresh();
    });

    // 重新扫描：强制重读 storage + 允许重新勾选（用户主动操作，语义上就是"重来一遍"）
    panel.querySelector("#qb-rescan").addEventListener("click", () => {
      resetSelectState();
      refresh(true);
    });

    // 面板内提示：替代 alert()。原生弹窗会打断做题（还要多点一次"确定"），
    // 而且选中文字触发自动搜索时弹窗非常扰人，一律改为列表区显示一条提示。
    function panelMsg(html) {
      if (listEl) listEl.innerHTML = `<div class="qb-item qb-none">${html}</div>`;
    }

    // 本地搜索：用内容在题库中模糊搜索（应对识别不到的题目）
    // fromAuto = true 表示由“选中页面文字”自动触发；searchSeq 防止连续触发时旧结果覆盖新结果
    let searchSeq = 0;
    async function runLocalSearch(q, fromAuto) {
      const seq = ++searchSeq;
      if (!q) { panelMsg("请先输入或选中要搜索的题目内容"); return; }
      const data = await loadData();
      if (seq !== searchSeq) return; // 已有更新的搜索
      const bank = (data.qb_remote_questions || []).concat(data.qb_questions || []);
      if (!bank.length) {
        panelMsg("题库为空：请在扩展 popup 中配置远程题库链接，或点面板上的「+ 录入」添加题目" +
          (fromAuto ? "<br>（取消选中文字后自动恢复题目列表）" : ""));
        return;
      }
      const threshold = Number(data.qb_threshold) || 70;
      const nq = normalize(q);
      // 搜索词只归一化一次。原来在循环里调 similarity()，每条题库都要把搜索词和整条题干
      // 重新 normalize + bigrams 一遍（几千题 = 几千次重复计算），每次选中文字都卡一下。
      // 这里把 bigrams 提出来复用，"题干+答案"的全文本次算过之后也存在索引条目上复用。
      const gq = bigrams(nq);
      const fullScore = (e) => {
        if (e.nFull === undefined) {
          e.nFull = normalize(e.item.q + " " + (e.item.a || ""));
          e.nFullBig = e.nFull ? bigrams(e.nFull) : null;
        }
        return e.nFull ? simN(nq, gq, e.nFull, e.nFullBig) : 0;
      };
      const scored = getIndex(bank)
        .map((e) => ({
          item: e.item,
          score: Math.max(simN(nq, gq, e.nq, e.nqBig), Math.round(fullScore(e) * 0.9)),
        }))
        .filter((x) => x.score >= threshold) // 低于 popup 设置的匹配度阈值不显示
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      if (seq !== searchSeq) return;
      if (!scored.length) {
        listEl.innerHTML = `<div class="qb-item qb-none">题库（共 ${bank.length} 题）中没有达到匹配阈值（${threshold}%）的题目` +
          (fromAuto ? "，取消选中文字后自动恢复题目列表" : "") + `</div>`;
        return;
      }
      listEl.innerHTML = `<div class="qb-item qb-search-head">🔍 ${fromAuto ? "选中文字搜索结果" : "本地搜索结果"}（${scored.length}）<span class="qb-link" id="qb-back">返回题目列表</span></div>`;
      scored.forEach(({ item, score }) => {
        const div = document.createElement("div");
        div.className = "qb-item";
        const qs = item.q.length > 40 ? item.q.slice(0, 40) + "…" : item.q;
        div.innerHTML = `
          <div class="qb-q">${escapeHtml(qs)}<span class="qb-score">${Math.round(score)}%</span></div>
          ${answerHtml(item.a, { options: optionsFromText(item.q) })}
        `;
        listEl.appendChild(div);
      });
      listEl.querySelector("#qb-back").addEventListener("click", () => {
        autoSearch = false;
        refresh();
      });
    }
    panel.querySelector("#qb-local-go").addEventListener("click", () =>
      runLocalSearch(searchInput.value.trim(), false)
    );

    // 选中页面文字 → 自动用选中内容搜索题库并显示结果；取消选中 → 恢复题目列表
    let selTimer = null;
    let autoSearch = false;
    document.addEventListener("selectionchange", () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        if (!listEl) return;
        const sel = window.getSelection();
        const node = sel && sel.anchorNode;
        // 面板内（含输入框）的选中不触发，避免复制答案时把列表换掉
        if (node && node.parentElement && node.parentElement.closest("#qb-helper-panel")) return;
        const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
        if (text.length >= 2) {
          searchInput.value = text;
          autoSearch = true;
          runLocalSearch(text, true);
        } else if (autoSearch) {
          autoSearch = false; // 取消选中：恢复成识别出的题目列表
          refresh();
        }
      }, 350);
    });

    // 手动把选中文字填入
    panel.querySelector("#qb-search-fill").addEventListener("click", () => {
      const sel = window.getSelection().toString().trim();
      if (sel) searchInput.value = sel;
    });

    // 选中页面文字后自动填入搜索框（选取非面板内文字时）
    // 必须用 window 捕获阶段：页面常在上层容器里拦 mouseup
    window.addEventListener("mouseup", () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        if (sel.anchorNode && sel.anchorNode.parentElement &&
            sel.anchorNode.parentElement.closest("#qb-helper-panel")) return;
        const text = sel.toString().trim();
        if (text && text.length >= 2) searchInput.value = text;
      }, 10);
    }, true);
  }

  /* ---------------------------------------------------------
   * 5.5 iframe 结果汇总（子框架没有悬浮窗，把统计回传给顶层）
   * --------------------------------------------------------- */
  const frameStats = new Map();
  // 当前文档里真实存在的 iframe 窗口（含同源嵌套frame）。
  // 两件事要用它：① 旧 iframe 被移除后统计要跟着掉，不然"内嵌框架另有 N 道题"只涨不降；
  //               ② 消息来源校验，页面里任意窗口伪造一条 __qbFrame 都往面板里插话终究不合适。
  function liveFrameWindows() {
    const set = new Set();
    const walk = (doc, depth) => {
      if (depth > 3) return;
      doc.querySelectorAll("iframe").forEach((f) => {
        let w = null;
        try { w = f.contentWindow; } catch (e) { return; } // 跨域取不到就到此为止
        if (!w || set.has(w)) return;
        set.add(w);
        try { walk(w.document, depth + 1); } catch (e) { /* 跨域，跳过嵌套 */ }
      });
    };
    walk(document, 0);
    return set;
  }
  function reportFrameResult(total, matched) {
    if (IS_TOP) return;
    try { window.top.postMessage({ __qbFrame: true, total, matched }, "*"); } catch (e) {}
  }
  function bindFrameMessages() {
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (!d || d.__qbFrame !== true) return;
      if (!e.source || e.source.closed) return;
      if (!liveFrameWindows().has(e.source)) return; // 不是本页面里的 frame，忽略
      frameStats.set(e.source, { total: d.total | 0, matched: d.matched | 0 });
      renderFrameNote();
    });
  }
  function renderFrameNote() {
    if (!listEl) return;
    const old = listEl.querySelector(".qb-frame-note");
    if (old) old.remove();
    let total = 0, matched = 0;
    // 顺手把已经移除 / 已关闭的 frame 统计清掉，否则题数一直累加到离谱的数字
    const live = liveFrameWindows();
    frameStats.forEach((v, src) => {
      if (!live.has(src) || src.closed) { frameStats.delete(src); return; }
      total += v.total; matched += v.matched;
    });
    if (!total) return;
    const div = document.createElement("div");
    div.className = "qb-item qb-frame-note";
    div.textContent = `🖼 内嵌框架中另有 ${total} 道题，已匹配 ${matched} 道（答案已在框架内高亮 / 勾选）`;
    listEl.appendChild(div);
  }

  /* ---------------------------------------------------------
   * 6. 主流程：扫描 + 匹配 + 渲染 + 高亮
   * --------------------------------------------------------- */
  let refreshSeq = 0; // 防止两次 refresh 交错渲染（旧的慢一拍，把新结果覆盖成半截）
  async function refresh(force) {
    const seq = ++refreshSeq;
    let data;
    try {
      data = await loadData(force); // force=true 时强制重读 storage（手动重新扫描 / 录入后）
    } catch (e) {
      if (listEl) {
        listEl.innerHTML = `<div class="qb-item qb-none">读取本地题库失败：${escapeHtml(e.message)}</div>`;
      }
      return;
    }
    if (seq !== refreshSeq) return; // 已经有更新的刷新在跑

    // 悬浮窗关闭 = 暂停：清掉已画的高亮和已回填的值，本轮不再扫描 / 自动勾选。
    // 之前这里只是把窗口 display:none，后台照常点击 —— 用户既看不到"哪几题没勾上"
    // 的提示，也没法在插件误判时立刻叫停，等于一个看不见的东西在替他答卷。
    if (data.qb_panel_visible === false) {
      clearHighlights();
      revertFills(null);
      resetSelectState();
      lastScan = { at: Date.now(), list: [] };
      if (listEl) {
        listEl.innerHTML = `<div class="qb-item qb-none">已暂停（悬浮窗已关闭）</div>`;
      }
      reportFrameResult(0, 0);
      return;
    }

    // 远程题库 + 本地题库合并使用
    const bank = (data.qb_remote_questions || []).concat(data.qb_questions || []);
    const threshold = Number(data.qb_threshold) || 70;

    if (countEl) countEl.textContent = "题库: " + bank.length;
    clearHighlights();
    if (window.__qbCleanAttrs) window.__qbCleanAttrs(); // 清理后插入的禁用属性

    const questions = findQuestionContainers(data.qb_selectors);
    if (seq !== refreshSeq) return;
    // 留给勾选队列：页面重渲染后按题干重新定位节点用
    lastScan = { at: Date.now(), list: questions };
    if (!questions.length) {
      if (listEl) listEl.innerHTML = `<div class="qb-item qb-none">未在页面中识别到题目</div>`;
      renderFrameNote();
      reportFrameResult(0, 0);
      return;
    }

    const index = getIndex(bank); // 题库没变时复用索引，不再重复 normalize 整个题库
    dbgBankSize = index.length; // 供测试校验同题干归并效果
    const TYPE_LABEL = { single: "单选", multi: "多选", blank: "填空" };
    let matchedCount = 0;

    if (listEl) listEl.innerHTML = "";
    const nonBlankKeys = new Set(); // 本轮已确认「不是填空题」的题干，用于撤回上一轮的误填
    questions.forEach((q) => {
      const qType = detectType(q);

      // 找最佳匹配：题库侧已预归一化，同一题干的匹配结果会被缓存（matchCache）
      const nStem = normalize(q.stem);
      const { item: best, score: bestScore } = matchQuestion(index, threshold, nStem, normalize(q.raw));
      q.selKey = nStem; // 供勾选队列去重

      const matched = best && bestScore >= threshold;
      if (matched) matchedCount++;

      // 匹配到答案且为多答案形式（A’B’D / ABD / 文字1’文字2）时，自动按多选处理
      let effType = qType;
      if (matched && qType === "single" &&
          (parseAnswerLetters(best.a).length > 1 || splitAnswerParts(best.a).length > 1)) {
        effType = "multi";
      }

      if (effType !== "blank") nonBlankKeys.add(nStem);

      if (matched && effType === "blank") {
        highlightAnswer(q, best.a);
        if (data.qb_auto_fill_blank !== false) doFillBlank(q, best.a); // 填空题直接写进输入框
      } else if (matched) {
        highlightAnswer(q, best.a);
        if (data.qb_auto_select !== false) {
          queueSelect(q, best.a); // 单选/多选：排队自动勾选（带间隔，防"并发限制"）
        }
      }

      // 子框架没有面板，渲染全部跳过
      if (!listEl) return;

      const item = document.createElement("div");
      item.className = "qb-item";
      const stemShort = q.stem.length > 40 ? q.stem.slice(0, 40) + "…" : q.stem;
      const typeBadge = `<span class="qb-type qb-type-${effType}">${TYPE_LABEL[effType]}</span>`;
      if (matched) {
        const lowConf = bestScore < Math.min(threshold + 10, 99)
          ? `<div class="qb-lowconf">匹配度偏低，请自行核对</div>` : "";
        item.innerHTML = `
          <div class="qb-q">${typeBadge}<b>题${q.index}</b> ${escapeHtml(stemShort)}
            <span class="qb-score">${Math.round(bestScore)}%</span></div>
          ${answerHtml(best.a, q)}
          ${lowConf}
        `;
      } else {
        item.innerHTML = `
          <div class="qb-q">${typeBadge}<b>题${q.index}</b> ${escapeHtml(stemShort)}</div>
          <div class="qb-a qb-noanswer">此题无答案${bank.length ? "" : "（题库为空）"}</div>
        `;
      }
      listEl.appendChild(item);
    });

    revertFills(nonBlankKeys); // 上一轮误当填空题填进去的值，认出是选择题就撤回来
    renderFrameNote();
    renderSelectNote();
    reportFrameResult(questions.length, matchedCount);
  }

  // 防抖刷新：避免输入选择器时每敲一个字都全量重扫。
  // 必须有"最长等待"：原来纯 clearTimeout，页面只要每 1.2s 内有元素级变化
  // （轮播、进度条、公告）就永远等不到刷新，后加载的题目一直识别不到。
  let refreshTimer = null;
  let refreshPendingAt = 0;
  const REFRESH_MAX_WAIT = 4000;
  function refreshSoon(delay) {
    const now = Date.now();
    if (!refreshPendingAt) refreshPendingAt = now;
    const wait = Math.min(delay || 300, Math.max(0, refreshPendingAt + REFRESH_MAX_WAIT - now));
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshPendingAt = 0;
      refresh();
    }, wait);
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // 答案渲染：多选题（或答案含多个部分）时每个选项单独一行，单选/填空保持一行
  // 字母答案（A’B’D / ABD）会尽量带上页面上对应的选项文字
  function answerHtml(answer, question) {
    const raw = (answer || "").trim();
    if (!raw) return `<div class="qb-a qb-noanswer">此题无答案</div>`;
    let parts = splitAnswerParts(raw);
    if (parts.length <= 1) {
      const letters = parseAnswerLetters(raw);
      if (letters.length > 1) parts = letters; // 连写 ABD → A / B / D
    }
    if (parts.length <= 1) return `<div class="qb-a">答：${escapeHtml(raw)}</div>`;

    const optMap = new Map();
    if (question && Array.isArray(question.options)) {
      question.options.forEach((o) => optMap.set(o.letter, o.text));
    }
    const lines = parts.map((p) => {
      const isLetter = /^[A-G]$/.test(p);
      const bullet = isLetter ? p + "." : "·";
      const text = isLetter ? (optMap.get(p) || "") : p;
      return `<div class="qb-a-line"><span class="qb-a-bullet">${escapeHtml(bullet)}</span>` +
        `<span class="qb-a-text">${escapeHtml(text)}</span></div>`;
    }).join("");
    return `<div class="qb-a qb-a-multi"><span class="qb-a-label">答：</span>` +
      `<div class="qb-a-lines">${lines}</div></div>`;
  }

  /* ---------------------------------------------------------
   * 8. 启动 & 监听设置变化
   * --------------------------------------------------------- */
  async function init() {
    let d;
    try {
      d = await loadData();
    } catch (e) {
      // storage 读失败（隐私模式 / 配额异常）时不能让整个插件静默失效：
      // 悬浮窗照样要建出来，refresh 里会把错误显示在列表上，用户才知道发生了什么
      console.warn("[答题助手] 读取本地题库失败，先用默认设置运行：", e);
      d = Object.assign({}, DEFAULTS);
    }

    if (IS_TOP) {
      createPanel(d.qb_panel_pos);
      if (d.qb_panel_visible === false) panel.style.display = "none";
      bindFrameMessages();
    }

    refresh();

    // 题库 / 阈值 / 开关变化时自动刷新
    // 只有影响识别结果的键才作废缓存并允许重新勾选；
    // qb_panel_pos 这类自身写入的键不参与，避免拖动窗口就触发一次全量重扫
    const WATCH_KEYS = [
      "qb_questions", "qb_remote_questions", "qb_threshold",
      "qb_selectors", "qb_auto_select", "qb_auto_fill_blank",
    ];
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.qb_panel_visible && panel) {
        panel.style.display = changes.qb_panel_visible.newValue === false ? "none" : "";
        // 暂停 / 恢复：清空勾选状态并立刻重扫一次（暂停时 refresh 会顺手清掉页面高亮）
        resetSelectState();
        refreshSoon(300);
      }
      if (WATCH_KEYS.some((k) => changes[k])) {
        invalidateData();
        resetSelectState(); // 题库/阈值变了，允许按新答案重新勾选
        refreshSoon(300);
      }
    });

    // 页面动态加载内容时延迟重扫；自身高亮/面板引起的 DOM 变化不触发，避免无限循环
    const observer = new MutationObserver((mutations) => {
      const onlySelf = mutations.every((m) => {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        if (!nodes.length) return true;
        return nodes.every((n) =>
          n.nodeType === 3 || // 文本节点（高亮拆合产生）
          (n.nodeType === 1 &&
            (n.id === "qb-helper-panel" ||
              n.classList.contains("qb-highlight") ||
              n.closest("#qb-helper-panel")))
        );
      });
      if (onlySelf) return;
      refreshSoon(1200);
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }

  // 调试钩子（供 test-sim.js 校验解析逻辑 / 调快勾选节奏，不影响功能）
  window.__qbDebug = {
    similarity, parseAnswerLetters, splitAnswerParts, judgeToken, findQuestionContainers,
    splitOptionMarks, clickOption, qStart: Q_START,
    autoSelectCfg, queueLen: () => selectQueue.length, bankSize: () => dbgBankSize,
    doneCount: () => selectDone.size, matchCacheSize: () => matchCache.size,
    failedCount: () => selectFailed.size, lastScan: () => lastScan,
  };

  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init);
})();

/* popup.js - 设置页逻辑 */
(function () {
  "use strict";
  const DEFAULTS = {
    qb_questions: [],          // 本地题库（手动录入 + 导入）
    qb_remote_questions: [],   // 远程题库（从链接加载）
    qb_remote_url: "https://raw.giteeusercontent.com/GGM6666/dati/raw/main/question.json",// 默认的远程题库
    qb_remote_fetched_at: 0,   // 上次成功拉取远程题库的时间（做自动更新节流）
    qb_threshold: 70,
    qb_selectors: "",          //题目识别默认值的class
    qb_panel_visible: true,
    qb_panel_pos: null,
    qb_auto_select: true,
    qb_auto_fill_blank: true,  // 填空题自动填值
    qb_sync_overwrite: true,   // 上传时同题干用本地答案覆盖云端（修正错题）
    qb_api_base: "",           // 自建平台的 API 基地址（留空自动探测）
    qb_api_cache: null,        // 探测成功的 API 基地址缓存（{host,base,scheme}），省掉重复探测
    qb_github_token: "",
    qb_update_info: null,         // 最近一次查到的升级信息 {version,notes,url,publishedAt}
    qb_update_checked_at: 0,      // 上次检查时间（节流用）
    qb_update_dismissed: "",      // 用户点过「忽略」的版本号
  };

  // 打开 popup 时自动更新远程题库的最小间隔：题库不会一分钟变一次，
  // 但用户可能反复点开 popup，每次都全量下载会浪费流量、也容易触发平台限流
  const REMOTE_TTL = 10 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  // 是否在扩展环境里（直接双击打开 popup.html 预览时没有 chrome API）
  const HAS_CHROME = !!(window.chrome && chrome.storage && chrome.storage.local);

  function load() {
    return new Promise((resolve, reject) => {
      if (!HAS_CHROME) { resolve(Object.assign({}, DEFAULTS)); return; }
      chrome.storage.local.get(DEFAULTS, (data) => {
        const err = (chrome.runtime && chrome.runtime.lastError) || null;
        // 读取失败必须 reject：否则拿到一堆 undefined 继续往下跑，
        // 界面显示 0 题、开关全关，看起来像"题库丢了"
        if (err) reject(new Error(err.message));
        else resolve(data);
      });
    });
  }
  function save(obj) {
    return new Promise((resolve, reject) => {
      if (!HAS_CHROME) { resolve(); return; }
      chrome.storage.local.set(obj, () => {
        // 不检查 lastError 的话，写入超限（题库过大）会静默失败，
        // 界面上却显示"已加载 N 题 / 已上传成功"，用户以为存住了
        const err = (chrome.runtime && chrome.runtime.lastError) || null;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }
  // 输入框实时保存用：失败时只提示，不抛出未处理的 Promise 拒绝
  function saveQuiet(obj) {
    return save(obj).catch((e) => msg("保存失败：" + e.message, "#c62828"));
  }
  // 输入框实时保存：原来每次按键都写一次 storage ——
  // 题库几千条时每次都要整包序列化，Token 明文写入也过于频繁。
  // 统一 300ms 防抖，change / blur 立即落盘，避免 popup 关闭时丢最后的输入。
  function debounce(fn, ms) {
    let timer = null;
    const wrapped = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(); }, ms);
    };
    wrapped.flush = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      fn();
    };
    return wrapped;
  }
  function bindLiveSave(id, build) {
    const el = $(id);
    if (!el) return null;
    const write = debounce(() => saveQuiet(build(el.value)), 300);
    el.addEventListener("input", write);
    el.addEventListener("change", write.flush);
    el.addEventListener("blur", write.flush);
    return write;
  }
  // 题目字段归一化：兼容 {"q","a"} 和 {"Q","A"} 两种键名，统一转为小写 q/a；无效返回 null
  function normalizeEntry(x) {
    if (!x || typeof x !== "object") return null;
    const q = typeof x.q === "string" ? x.q : (typeof x.Q === "string" ? x.Q : null);
    const a = typeof x.a === "string" ? x.a : (typeof x.A === "string" ? x.A : null);
    if (q === null || a === null) return null;
    return { q, a };
  }
  function msg(text, color) {
    const el = $("op-msg");
    el.textContent = text;
    el.style.color = color || "#2e7d32";
    // 连点按钮时旧定时器会把新提示清掉，这里统一管理
    clearTimeout(msg.timer);
    msg.timer = setTimeout(() => (el.textContent = ""), 3000);
  }
  // 统一设置状态行。kind: "loading" | "ok" | "warn" | "fail" | ""
  // 必须保留 "status" 基类：原来直接写 className = "ok" 会把基类冲掉，
  // 状态行就只剩颜色、丢了内边距和圆角。
  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  }
  /* 版本号按钮本身就是更新检查的状态灯：
   * 默认蓝 → 检查中淡黄 → 无更新绿 → 有更新 / 检查失败红。
   * kind 传空串恢复默认蓝，title 用来放详细说明（悬停可见）。 */
  function setVerBtn(text, kind, tip) {
    const el = $("ver-now");
    if (!el) return;
    el.textContent = text || "当前 v" + currentVersion();
    el.className = "badge ver-btn" + (kind ? " v-" + kind : "");
    el.title = tip || "点击检查更新";
  }
  // 异步操作期间禁用按钮，避免连点发出并发请求（加载题库 / 上传 / 检查更新）
  function busy(ids, on) {
    (ids || []).forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !!on;
    });
  }
  // 滑块已填充部分的宽度（10~100 映射到 0~100%）
  function syncThresholdFill(v) {
    const el = $("threshold");
    if (!el) return;
    const pct = Math.max(0, Math.min(100, ((Number(v) - 10) / 90) * 100));
    el.style.setProperty("--p", pct + "%");
  }
  // 显示 远程 + 本地 合并后的总题数（标签徽标 + 题库卡片里的三格统计）
  function refreshCount(data) {
    const remote = (data.qb_remote_questions || []).length;
    const local = (data.qb_questions || []).length;
    const total = remote + local;
    const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    setText("bank-count", total);
    setText("bank-total", "共 " + total + " 题");
    setText("remote-count", remote);
    setText("local-count", local);
    setText("total-count", total);
  }

  /* ---------- 远程题库加载 ---------- */
  async function loadRemote(url, isAuto) {
    const status = $("remote-status");
    const info = parseRepoRawUrl(url);
    const tag = info
      ? (info.provider === "gitee" ? "Gitee"
        : info.provider === "ghlike" ? (info.host || "自建平台")
        : "GitHub")
      : "";
    const data = await load();

    // 自动更新节流：10 分钟内不重复拉（题库不会一分钟变一次，但用户会反复点开 popup）
    if (isAuto) {
      const last = Number(data.qb_remote_fetched_at) || 0;
      if (last && Date.now() - last < REMOTE_TTL) {
        const n = (data.qb_remote_questions || []).length;
        setStatus(status, "✔ 已缓存 " + n + " 题" + (tag ? "（" + tag + "）" : "") +
          "，10 分钟内不重复拉取", "ok");
        return;
      }
    }

    busy(["remote-load"], true);
    setStatus(status, "加载中…", "loading");
    try {
      // 只有手动点「加载题库」才加时间戳穿透 CDN（用户明确要最新）；
      // 自动更新走正常缓存。原来两条路径都加 _t，等于每次开 popup 都强制回源，
      // 大题库 + 频繁开关 popup 很容易吃到平台限流。
      const bust = isAuto ? url : url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
      const res = await fetch(bust, isAuto ? {} : { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rawList = await res.json();
      if (!Array.isArray(rawList)) throw new Error("格式应为 JSON 数组");
      const list = rawList.map(normalizeEntry).filter(Boolean); // 兼容 q/a 和 Q/A 键名
      if (!list.length) throw new Error('未解析到有效题目，格式应为 [{"q":"题目","a":"答案"}, …]（键名大小写均可）');

      // 内容没变就不再写一遍 storage（省掉整个题库的序列化 + 写入开销）
      const prev = data.qb_remote_questions || [];
      const unchanged = prev.length === list.length &&
        list.every((x, i) => prev[i] && prev[i].q === x.q && prev[i].a === x.a);
      if (unchanged) {
        await saveQuiet({ qb_remote_url: url, qb_remote_fetched_at: Date.now() });
        setStatus(status, "✔ 云端题库无变化（" + list.length + " 题）" +
        (tag ? "（" + tag + "）" : ""), "ok");
        return;
      }

      await save({ qb_remote_url: url, qb_remote_questions: list, qb_remote_fetched_at: Date.now() });
      setStatus(status, "✔ 已加载 " + list.length + " 题" + (tag ? "（" + tag + "）" : ""), "ok");
      refreshCount(await load());
    } catch (e) {
      const quota = /quota|QUOTA_BYTES/i.test(e.message)
        ? "（本地存储已满，请先「导出题库」再清空本地题目）" : "";
      setStatus(status, "✘ " + (isAuto ? "自动更新失败：" : "") + e.message + quota, "fail");
    } finally {
      busy(["remote-load"], false);
    }
  }
  $("remote-load").addEventListener("click", () => {
    const url = $("remote-url").value.trim();
    if (!url) { msg("请先填写题库链接", "#c62828"); return; }
    loadRemote(url, false);
  });
  // 链接输入实时保存（防抖），避免 popup 关闭时 change 未触发导致链接丢失。
  // 同时把拉取时间戳清零：节流只看时间不看链接，不清零的话换了新地址后
  // 10 分钟内的自动更新会被旧链接的时间戳挡掉，界面还显示着旧题库的题数。
  bindLiveSave("remote-url", (v) => ({ qb_remote_url: v.trim(), qb_remote_fetched_at: 0 }));

  /* ---------- 合并去重并上传到云端（GitHub / Gitee） ---------- */
  function normalizeQ(s) {
    return (s || "")
      // 与 content.js 的 normalize 保持一致：全角 ASCII 先转半角，
      // 否则同一道题在插件端和上传端会算出不同的归并 key
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  }
  // 按题干归并：题干相同视为同一题
  //   overwrite = true  → 用本地答案覆盖已有答案（修正错题）
  //   overwrite = false → 已有题干全部保留原答案，只追加新题
  // 云端自身的历史重复题干也会一并清理（同题干保留最后出现的那条答案）
  // 返回 { merged, added, updated, same, skipped, deduped }
  // skipped：题干相同、答案不同，但因为没勾选"覆盖"而没有采纳的那部分本地题。
  //   它们既没有进 merged（不会上云），也绝对不能被随手清空 ——
  //   否则用户在悬浮窗里改过的答案就凭空消失了（上传成功后原本无条件清本地）。
  function mergeBanks(remoteList, localList, overwrite) {
    const merged = [];
    const posByKey = new Map();
    let deduped = 0;
    // 1. 云端条目：同题干只保留一条，重复的丢弃（答案取最后一条）
    (remoteList || []).forEach((x) => {
      if (!x || typeof x.q !== "string" || typeof x.a !== "string") return;
      const k = normalizeQ(x.q);
      if (!k) return;
      if (posByKey.has(k)) {
        const i = posByKey.get(k);
        if (merged[i].a !== x.a) merged[i] = { q: merged[i].q, a: x.a };
        deduped++;
        return;
      }
      posByKey.set(k, merged.length);
      merged.push({ q: x.q, a: x.a });
    });
    // 2. 本地条目：追加新题 / 覆盖同题干答案
    const added = [], updated = [], same = [], skipped = [];
    (localList || []).forEach((x) => {
      if (!x || typeof x.q !== "string" || typeof x.a !== "string") return;
      const k = normalizeQ(x.q);
      if (!k) return;
      if (!posByKey.has(k)) {
        posByKey.set(k, merged.length);
        merged.push({ q: x.q, a: x.a });
        added.push({ q: x.q, a: x.a });
        return;
      }
      const i = posByKey.get(k);
      const prev = merged[i];
      if (prev.a === x.a) { same.push({ q: x.q, a: x.a }); return; }
      if (overwrite) {
        merged[i] = { q: prev.q, a: x.a }; // 保留云端题干写法，只换答案
        updated.push({ q: prev.q, from: prev.a, to: x.a });
      } else {
        // 选择了"不覆盖"：这条本地答案没有被采用，原样留着，交给调用方决定去留
        skipped.push({ q: x.q, a: x.a, cloud: prev.a });
        same.push({ q: x.q, a: x.a });
      }
    });
    return { merged, added, updated, same, skipped, deduped };
  }
  // 解析 raw 链接 → { provider, owner, repo, branch, path, host? }
  // 支持：
  //   GitHub  https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}（含 /refs/heads/ 写法）
  //   Gitee   https://raw.giteeusercontent.com/{owner}/{repo}/raw/{branch}/{path}
  //   Gitee   https://gitee.com/{owner}/{repo}/raw/{branch}/{path}
  //   自建平台（GitHub 1:1 复刻，仅域名不同）：
  //           https://{host}/{owner}/{repo}/raw/{branch}/{path}
  //           https://raw.{host}/{owner}/{repo}/[{refs/heads/}]{branch}/{path}
  function parseRepoRawUrl(url) {
    const u = (url || "").trim();
    let m = u.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) {
      const [, owner, repo, rest] = m;
      const refs = rest.match(/^refs\/heads\/([^/]+)\/(.+)$/);
      if (refs) return { provider: "github", owner, repo, branch: refs[1], path: refs[2] };
      const parts = rest.split("/");
      return { provider: "github", owner, repo, branch: parts[0], path: parts.slice(1).join("/") };
    }
    m = u.match(/^https?:\/\/raw\.giteeusercontent\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/);
    if (m) return { provider: "gitee", owner: m[1], repo: m[2], branch: m[3], path: m[4] };
    m = u.match(/^https?:\/\/gitee\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/);
    if (m) return { provider: "gitee", owner: m[1], repo: m[2], branch: m[3], path: m[4] };
    // Gitee 网页地址（/blob/）：用户从浏览器地址栏复制过来的就是这种
    m = u.match(/^https?:\/\/gitee\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (m) return { provider: "gitee", owner: m[1], repo: m[2], branch: m[3], path: m[4] };
    // GitHub 网页地址（/raw/ 与 /blob/）：同上，最常见的"粘错格式"来源
    m = u.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\/([^/]+)\/(.+)$/);
    if (m) return { provider: "github", owner: m[1], repo: m[2], branch: m[3], path: m[4] };
    // 自建平台：同域 /{owner}/{repo}/raw/{branch}/{path}
    m = u.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/);
    if (m) {
      return { provider: "ghlike", host: m[1], owner: m[2], repo: m[3], branch: m[4], path: m[5], raw: false };
    }
    // 自建平台：raw 子域 /{owner}/{repo}/[{refs/heads/}]{branch}/{path}
    m = u.match(/^https?:\/\/raw\.([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) {
      const [, host, owner, repo, rest] = m;
      const refs = rest.match(/^refs\/heads\/([^/]+)\/(.+)$/);
      // raw 标记原链接用的是哪种形态：反拼升级信息地址时要照原样拼回去，
    // 否则在只支持其中一种写法的平台上会直接 404。
      if (refs) return { provider: "ghlike", host, owner, repo, branch: refs[1], path: refs[2], raw: true };
      const parts = rest.split("/");
      return { provider: "ghlike", host, owner, repo, branch: parts[0], path: parts.slice(1).join("/"), raw: true };
    }
    return null;
  }

  // parseRepoRawUrl 的逆操作：把解析结果重新拼成 raw 直链。
  // 用来在「题库链接」所在仓库里定位升级信息文件，用户不用再填一遍地址。
  function buildRepoRawUrl(info, path) {
    const p = String(path || "").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
    if (info.provider === "gitee") {
      return `https://raw.giteeusercontent.com/${info.owner}/${info.repo}/raw/${info.branch}/${p}`;
    }
    if (info.provider === "ghlike") {
      const host = (info.host || "").replace(/^raw\./, "");
      return info.raw
        ? `https://raw.${host}/${info.owner}/${info.repo}/${info.branch}/${p}`
        : `https://${host}/${info.owner}/${info.repo}/raw/${info.branch}/${p}`;
    }
    return `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.branch}/${p}`;
  }

  // 自建平台的 API 基地址候选（GitHub 1:1 复刻常见的几种形态）
  // 用户填了「API 基地址」就只用它，否则按下面的顺序探测
  function apiCandidates(info, preferred) {
    const list = [];
    const add = (s) => { if (s && !list.includes(s)) list.push(s); };
    if (preferred) add(preferred.trim().replace(/\/+$/, ""));
    const host = (info.host || "").replace(/^raw\./, "");
    add("https://api." + host);        // GitHub 风格：api.example.com/repos/...
    add("https://" + host + "/api/v3"); // GitHub Enterprise 风格
    add("https://" + host + "/api/v1"); // Gitea / Forgejo 风格
    add("https://" + host);             // 直接同域 /repos/...
    return list;
  }

  // 按平台生成接口地址 / 请求头 / 请求体
  function repoApi(info, token, opts) {
    opts = opts || {};
    if (info.provider === "gitee") {
      const base = `https://gitee.com/api/v5/repos/${info.owner}/${info.repo}/contents/${info.path}`;
      const q = "access_token=" + encodeURIComponent(token);
      return {
        label: "Gitee",
        getUrl: `${base}?${q}&ref=${encodeURIComponent(info.branch)}`,
        putUrl: base,
        getHeaders: {},
        putHeaders: { "Content-Type": "application/json" },
        // Gitee：token 放在 body 里，content 为 base64，更新必须带 sha
        putBody: (content, message, sha) => ({ access_token: token, content, message, sha, branch: info.branch }),
        hint401: "（私人令牌无效或已过期）",
        hint403: "（令牌权限不足：需勾选 projects 项目权限，且账号需有该仓库写权限）",
      };
    }
    if (info.provider === "ghlike") {
      const base = (opts.base || "https://api." + (info.host || "").replace(/^raw\./, "")).replace(/\/+$/, "");
      const url = `${base}/repos/${info.owner}/${info.repo}/contents/${info.path}`;
      const scheme = opts.scheme || "token"; // Gitea / 多数复刻用 token，GitHub 兼容 Bearer
      const headers = { Authorization: `${scheme} ${token}`, Accept: "application/vnd.github+json" };
      return {
        label: "自建平台 " + base.replace(/^https?:\/\//, ""),
        base,
        scheme,
        getUrl: `${url}?ref=${encodeURIComponent(info.branch)}`,
        putUrl: url,
        getHeaders: headers,
        putHeaders: Object.assign({ "Content-Type": "application/json" }, headers),
        putBody: (content, message, sha) => ({ message, content, sha, branch: info.branch }),
        hint401: "（令牌无效或已过期）",
        hint403: "（令牌权限不足：需要该仓库的 Contents 读写权限）",
      };
    }
    const base = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${info.path}`;
    const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return {
      label: "GitHub",
      getUrl: `${base}?ref=${encodeURIComponent(info.branch)}`,
      putUrl: base,
      getHeaders: headers,
      putHeaders: Object.assign({ "Content-Type": "application/json" }, headers),
      putBody: (content, message, sha) => ({ message, content, sha, branch: info.branch }),
      hint401: "（Token 无效或已过期）",
      hint403: "（Token 权限不足：classic 需勾 repo；fine-grained 需 Contents 读写权限）",
    };
  }

  // 自建平台：依次探测 API 基地址 + 鉴权头写法，选中能读到文件的那个
  async function resolveRepoApi(info, token, preferred) {
    if (info.provider !== "ghlike") return repoApi(info, token);

    // 探测一次就要下载整个题库文件（contents 接口直接返回 base64 内容），
    // 失败时最多 8 个候选 = 8 次全量下载。成功一次就把地址缓存下来复用。
    const data = await load();
    const cached = data.qb_api_cache;
    if (!preferred && cached && cached.host === info.host && cached.base) {
      const api = repoApi(info, token, { base: cached.base, scheme: cached.scheme });
      try {
        const r = await fetch(api.getUrl, { headers: api.getHeaders, cache: "no-cache" });
        if (r.status === 200) return api;
      } catch (e) { /* 缓存地址不可达，继续重新探测 */ }
    }

    const tried = [];
    let authFail = null;
    for (const base of apiCandidates(info, preferred)) {
      for (const scheme of ["token", "Bearer"]) {
        const api = repoApi(info, token, { base, scheme });
        tried.push(`${base} [${scheme}]`);
        let res;
        try {
          res = await fetch(api.getUrl, { headers: api.getHeaders, cache: "no-cache" });
        } catch (e) {
          break; // 该基地址网络不可达，换下一个
        }
        if (res.status === 200) {
          saveQuiet({ qb_api_cache: { host: info.host, base, scheme } });
          return api;
        }
        // 401 / 403：地址多半是对的，只是鉴权写法不匹配 —— 换另一种 Authorization 再试一次。
        // 原来这里写的是 break，导致循环里的 "Bearer" 永远轮不到，只支持 token 写法的平台才能探测成功。
        if (res.status === 401 || res.status === 403) { authFail = api; continue; }
        break; // 404 等：该基地址不是文件接口，换下一个
      }
    }
    if (authFail) return authFail; // 地址对了但令牌不行，交给后续报错提示
    const err = new Error("无法识别该平台的 API 地址（已尝试 " + tried.length + " 个），请在下方填写「API 基地址」");
    err.tried = tried;
    throw err;
  }

  function b64encodeUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(bin);
  }
  function b64decodeUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // 令牌同样实时保存：popup 关闭时 change 可能来不及触发，Token 会白填
  bindLiveSave("github-token", (v) => ({ qb_github_token: v.trim() }));

  $("sync-upload").addEventListener("click", async () => {
    const status = $("sync-status");
    const token = $("github-token").value.trim();
    await saveQuiet({ qb_github_token: token }); // 上传前兜底保存，防止 change 未触发
    const data = await load();
    const info = parseRepoRawUrl((data.qb_remote_url || "").trim());
    if (!info) {
      setStatus(status, "✘ 无法识别该链接：支持 raw.githubusercontent.com/…、raw.giteeusercontent.com/…、" +
        "github.com 与 gitee.com 的 /raw/ 或 /blob/ 地址、自建平台的 /{owner}/{repo}/raw/… 地址", "fail");
      return;
    }
    if (!token) {
      setStatus(status, "✘ 请先填写访问令牌" + (info.provider === "gitee" ? "（Gitee 私人令牌）" : ""), "fail");
      return;
    }
    busy(["sync-upload"], true);
    setStatus(status, info.provider === "ghlike" ? "探测接口地址…" : "同步中…", "loading");
    let api;
    try {
      api = await resolveRepoApi(info, token, (data.qb_api_base || "").trim());
    } catch (e) {
      setStatus(status, "✘ " + e.message, "fail");
      busy(["sync-upload"], false);
      return;
    }
    try {
      // 1. 读取云端最新内容和文件 sha（上传时必须携带）
      const getRes = await fetch(api.getUrl, { headers: api.getHeaders, cache: "no-cache" });
      if (!getRes.ok) {
        const err0 = await getRes.json().catch(() => ({}));
        throw new Error("读取云端失败 HTTP " + getRes.status + (err0.message ? "：" + err0.message : "") +
          (getRes.status === 401 ? api.hint401 : getRes.status === 403 ? api.hint403 : ""));
      }
      const file = await getRes.json();
      let remoteList = [];
      let cloudUpperKeys = false; // 云端文件是否使用 Q/A 大写键名
      try {
        const parsed = JSON.parse(b64decodeUtf8(file.content));
        if (Array.isArray(parsed)) {
          cloudUpperKeys = parsed.some((x) => x && typeof x === "object" && typeof x.Q === "string");
          remoteList = parsed.map(normalizeEntry).filter(Boolean); // 兼容 q/a 和 Q/A
        }
      } catch (e) { /* 云端为空或格式异常按空处理 */ }

      // 2. 合并：同题干视为同一题；勾选"覆盖"时用本地答案修正云端旧答案
      const overwrite = $("sync-overwrite").checked;
      const { merged, added, updated, skipped, deduped } = mergeBanks(remoteList, data.qb_questions || [], overwrite);
      // skipped 里带了 cloud 字段（用于提示），存回本地/导出前要剥掉
      const keepLocal = skipped.map(({ q, a }) => ({ q, a }));

      if (!added.length && !updated.length && !deduped) {
        // 关键点：只有确认本地没有"留存项"时才清空。
        // skipped 里是题干相同、答案不同且用户选择不覆盖的题，它们没有并进云端，
        // 跟着一起清掉就等于把用户改过的答案丢掉了。
        await save({ qb_questions: keepLocal });
        refreshCount(await load());
        if (skipped.length) {
          setStatus(status, "⚠ 云端无需变更（" + merged.length + " 题）；" +
            skipped.length + " 题本地答案与云端不同，因未勾选「覆盖」已保留在本地未上传" +
            "（想要覆盖请勾选上面的开关再上传）", "warn");
        } else {
          setStatus(status, "✔ 云端已是最新，无需上传，本地已清空", "ok");
        }
        return;
      }

      // 3. 上传合并结果（保持云端原有键名风格：Q/A 或 q/a）
      const out = cloudUpperKeys
        ? merged.map((x) => ({ Q: x.q, A: x.a }))
        : merged;
      // contents 接口（GitHub / Gitee / 多数复刻平台）单文件上限 1MB，
      // 超了只会返回语焉不详的 403/422。这里提前算体积，给出能操作的提示。
      const content64 = b64encodeUtf8(JSON.stringify(out, null, 2));
      const bytes = Math.ceil((content64.length * 3) / 4);
      if (bytes > 1024 * 1024) {
        setStatus(status, "✘ 题库文件约 " + (bytes / 1024 / 1024).toFixed(1) +
          " MB，超过云端 contents 接口 1MB 上限（约 4000~5000 题）。请先「导出题库」拆成多个文件，或改用自建平台", "fail");
        return;
      }
      const putRes = await fetch(api.putUrl, {
        method: "PUT",
        headers: api.putHeaders,
        body: JSON.stringify(api.putBody(
          content64,
          `Merge local question bank: +${added.length} ~${updated.length}` +
            (deduped ? ` -${deduped}` : "") + ` (total ${merged.length})`,
          file.sha
        )),
      });
      if (!putRes.ok) {
        const err = await putRes.json().catch(() => ({}));
        throw new Error("上传失败 HTTP " + putRes.status + (err.message ? "：" + err.message : "") +
          (putRes.status === 401 ? api.hint401 :
           putRes.status === 403 ? api.hint403 :
           putRes.status === 404 ? "（仓库/路径/分支不存在，或令牌无权访问）" :
           putRes.status === 413 ? "（题库文件超过接口上限，请拆分题库）" :
           putRes.status === 409 || putRes.status === 422 ? "（云端文件已被修改，请重新点一次上传）" : ""));
      }

      // 4. 成功：远程缓存更新为合并结果，本地保留 skipped（本次未采纳的那些），其余清空（已并入云端）
      await save({ qb_remote_questions: merged, qb_questions: keepLocal });
      refreshCount(await load());
      setStatus(status, `✔ 已上传到 ${api.label}：新增 ${added.length} 题` +
        (updated.length ? `，更新 ${updated.length} 题` : "") +
        (deduped ? `，清理重复 ${deduped} 条` : "") +
        (skipped.length ? `；${skipped.length} 题本地答案与云端不同（未勾选覆盖）已保留在本地` : "") +
        `，云端共 ${merged.length} 题`, skipped.length ? "warn" : "ok");
    } catch (e) {
      setStatus(status, "✘ " + e.message, "fail");
    } finally {
      busy(["sync-upload"], false);
    }
  });

  /* ---------- 标签页切换（答题 / 题库） ---------- */
  // 记住上次停留的标签：多数人打开 popup 是重复同一件事，省一次点击
  const TAB_KEY = "qb_popup_tab";
  function activateTab(name, remember) {
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".pane").forEach((p) => {
      const on = p.id === "pane-" + name;
      p.classList.toggle("is-active", on);
      // hidden 属性一并切换：display:none 之外再给读屏器一个明确状态
      if (on) p.removeAttribute("hidden");
      else p.setAttribute("hidden", "");
    });
    if (remember) {
      try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* 隐私模式下忽略 */ }
    }
  }
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => activateTab(t.dataset.tab, true));
    // 左右方向键切换（标签栏的标准键盘行为）
    t.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
      const i = tabs.indexOf(t);
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      if (next) { next.focus(); activateTab(next.dataset.tab, true); }
    });
  });
  // 恢复上次停留的标签
  try {
    if (localStorage.getItem(TAB_KEY) === "bank") activateTab("bank", false);
  } catch (e) { /* 隐私模式下忽略 */ }

  /* ---------- 插件升级提示 ----------
   * 做法：题库链接所在仓库的根目录放一个 version.json，每次打开弹窗时拉下来
   * 跟 manifest 里的版本比一比。地址由题库链接推导，不需要额外配置。
   * 注意：扩展没法给自己静默升级 —— 未上架的解压版更是只能手动换包，
   * 所以这里只提示 + 给下载地址，绝不做任何自动下载 / 安装。 */
  const UPDATE_TTL = 24 * 60 * 60 * 1000; // 自动检查的最小间隔：1 天
  const UPDATE_FILE = "version.json";

  // 只比数字段："v0.3.5" / "0.4" / "1.0.0-beta" 都能处理，返回 -1 / 0 / 1
  function cmpVer(a, b) {
    const pa = String(a || "").replace(/^v/i, "").split(/[^0-9]+/).filter(Boolean);
    const pb = String(b || "").replace(/^v/i, "").split(/[^0-9]+/).filter(Boolean);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = parseInt(pa[i], 10) || 0;
      const y = parseInt(pb[i], 10) || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  function currentVersion() {
    try {
      const mf = chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest();
      if (mf && mf.version) return String(mf.version);
    } catch (e) { /* 非扩展环境 */ }
    return "0.0.0";
  }

  // 升级信息地址：直接由题库链接推导 —— version.json 就放在同一个仓库的根目录
  function updateInfoUrl(data) {
    const info = parseRepoRawUrl((data.qb_remote_url || "").trim());
    return info ? buildRepoRawUrl(info, UPDATE_FILE) : "";
  }

  // 远端 JSON 容错：缺字段 / 类型不对都按无效处理，不往界面上塞脏数据
  function normalizeUpdate(info) {
    if (!info || typeof info !== "object") return null;
    const v = String(info.version == null ? "" : info.version).trim().replace(/^v/i, "");
    if (!/^\d+(\.\d+)*$/.test(v)) return null;
    const str = (x) => (typeof x === "string" ? x : "");
    return {
      version: v,
      notes: str(info.notes).slice(0, 400),
      url: str(info.url).trim(),
      publishedAt: str(info.publishedAt),
    };
  }

  // 只放行 http(s)：JSON 里的 url 是外部数据，别让它变成 javascript: 之类
  function safeHttpUrl(u) {
    try {
      const url = new URL(String(u || ""));
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch (e) { return ""; }
  }

  /* renderUpdate(info, dismissed, force)
   * force=true 表示用户手动点版本号检查 —— 此时忽略「已忽略」记录，有新版本就一定显示。
   * 否则点过一次 ✕ 就再也调不出来（连手动检查都不提示），用户会以为功能坏了。
   * 自动检查仍然尊重忽略记录，不会每次开弹窗都弹一遍。 */
  function renderUpdate(info, dismissed, force) {
    const box = $("update-box");
    if (!box) return;
    const latest = normalizeUpdate(info);
    if (!latest || cmpVer(latest.version, currentVersion()) <= 0) {
      box.hidden = true;
      setUpdateBadge(false);
      return;
    }
    if (force !== true && dismissed === latest.version) {
      box.hidden = true;
      setUpdateBadge(false);
      return;
    }
    box.dataset.version = latest.version;
    box.dataset.url = safeHttpUrl(latest.url);
    $("update-ver").textContent = "v" + latest.version;
    const notes = $("update-notes");
    notes.textContent = latest.notes || "";
    notes.hidden = !latest.notes;
    const go = $("update-go");
    if (go) go.hidden = !box.dataset.url;
    box.hidden = false;
    setUpdateBadge(true);
  }

  // 用缓存的升级信息渲染：节流命中 / 请求失败时都沿用上次结果，版本号同步显示状态色
  function renderCachedUpdate(data) {
    renderUpdate(data.qb_update_info, data.qb_update_dismissed);
    const latest = normalizeUpdate(data.qb_update_info);
    if (!latest) { setVerBtn("", "", ""); return; }
    if (cmpVer(latest.version, currentVersion()) > 0)
      setVerBtn("有新版本 v" + latest.version, "fail",
        "发现新版本 v" + latest.version + "，点击可重新检查");
    else
      setVerBtn("已是最新 v" + currentVersion(), "ok", "当前已是最新版本，点击可重新检查");
  }

  // 没有后台脚本，就在弹窗里顺手把工具栏角标点上（chrome.action 无需额外权限，
  // 角标会一直保留到下次修改）。这样不打开弹窗也能看到有新版本。
  function setUpdateBadge(on) {
    try {
      if (!chrome.action || !chrome.action.setBadgeText) return;
      chrome.action.setBadgeText({ text: on ? "1" : "" });
      chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
    } catch (e) { /* ignore */ }
  }

  async function checkUpdate(force) {
    if (!HAS_CHROME) return;
    const data = await load();
    const url = updateInfoUrl(data);
    if (!url) {
      renderUpdate(null, "");
      if (force === true) setVerBtn("无法检查", "fail", "还没配置题库链接，无法定位升级信息");
      return;
    }

    // 自动检查做节流：每天最多打一次网络请求，命中节流就直接用上次缓存的结果渲染
    if (force !== true) {
      const last = Number(data.qb_update_checked_at) || 0;
      if (last && Date.now() - last < UPDATE_TTL) {
        renderCachedUpdate(data);
        return;
      }
    }

    // 手动检查加时间戳穿透 CDN，否则刚推的版本要等缓存过期才看得到
    const fetchUrl = force === true ? url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now() : url;
    busy(["ver-now"], true);
    setVerBtn("检查中…", "loading", "正在检查更新…");
    try {
      const res = await fetch(fetchUrl, force === true ? { cache: "no-cache" } : {});
      if (!res.ok) throw new Error("HTTP " + res.status);
      const latest = normalizeUpdate(await res.json());
      if (!latest) throw new Error('version.json 里缺少 version 字段，或版本号不是 "1.2.3" 这样的数字形式');
      await saveQuiet({ qb_update_info: latest, qb_update_checked_at: Date.now() });
      renderUpdate(latest, data.qb_update_dismissed, force);
      const newer = cmpVer(latest.version, currentVersion()) > 0;
      if (newer) setVerBtn("有新版本 v" + latest.version, "fail",
        "发现新版本 v" + latest.version + "，点击可重新检查");
      else setVerBtn("已是最新 v" + currentVersion(), "ok",
        "当前已是最新版本，点击可重新检查");
    } catch (e) {
      setVerBtn("检查失败", "fail", "检查更新失败：" + e.message);
      renderUpdate(data.qb_update_info, data.qb_update_dismissed); // 拉不到就沿用上次结果
    } finally {
      busy(["ver-now"], false);
    }
  }

  // 点版本号手动检查更新
  if ($("ver-now")) $("ver-now").addEventListener("click", () => checkUpdate(true));
  if ($("update-go")) {
    $("update-go").addEventListener("click", () => {
      const u = $("update-box") && $("update-box").dataset.url;
      if (u && chrome.tabs) chrome.tabs.create({ url: u });
      else if (u) window.open(u, "_blank");
    });
  }
  if ($("update-dismiss")) {
    $("update-dismiss").addEventListener("click", () => {
      const box = $("update-box");
      const v = box && box.dataset.version;
      if (!v) return;
      box.hidden = true;
      setUpdateBadge(false);
      save({ qb_update_dismissed: v })
        .then(() => msg("已忽略 v" + v + "，出新版本时会再提醒"))
        .catch((err) => msg("保存失败：" + err.message, "#c62828"));
    });
  }

  /* ---------- 一次性清理 ----------
   * AI 提问功能已移除，但旧版本存过的配置还在 storage 里，其中 API Key 是明文。
   * 另外「打开弹窗时自动检查」的开关也删了，顺手清掉它留下的键
   * （更新检查现在固定为每天最多一次，不可关）。
   * 每次打开 popup 都尝试清一次（键不存在时 remove 是空操作，开销可忽略）。 */
  (function clearLegacyAiKeys() {
    if (!HAS_CHROME) return;
    try {
      chrome.storage.local.remove([
        "qb_ai_url", "qb_ai_base", "qb_ai_model", "qb_ai_key",
        "qb_ai_sys", "qb_ai_cache", "qb_ai_mode", "qb_bridge_url",
        "qb_update_enabled",
      ]);
    } catch (e) { /* 清理失败不影响使用 */ }
  })();

  /* ---------- 初始化 ---------- */
  load().then((data) => {
    $("threshold").value = data.qb_threshold;
    $("threshold-val").textContent = data.qb_threshold;
    syncThresholdFill(data.qb_threshold);
    $("q-selectors").value = data.qb_selectors;
    $("remote-url").value = data.qb_remote_url;
    $("github-token").value = data.qb_github_token;
    $("panel-visible").checked = data.qb_panel_visible !== false;
    $("auto-select").checked = data.qb_auto_select !== false;
    if ($("auto-fill")) $("auto-fill").checked = data.qb_auto_fill_blank !== false;
    $("sync-overwrite").checked = data.qb_sync_overwrite !== false;
    if ($("api-base")) $("api-base").value = data.qb_api_base || "";
    refreshCount(data);
    // 版本号直接读 manifest，避免和插件实际版本不一致（测试环境无 chrome.runtime，忽略）
    const ver = currentVersion();
    if ($("app-ver")) $("app-ver").textContent = "v" + ver;
    setVerBtn("当前 v" + ver, "", ""); // 默认蓝，检查结果出来后由 checkUpdate 改成绿 / 红
    // 已配置链接时，打开 popup 自动更新远程题库（预览环境没有扩展 API，跳过）
    if (data.qb_remote_url && HAS_CHROME) loadRemote(data.qb_remote_url, true);
    if (HAS_CHROME) checkUpdate(false);
  }).catch((e) => {
    // 读不到 storage 时界面不能停在空白状态
    $("remote-status").textContent = "✘ 读取本地设置失败：" + e.message;
    $("remote-status").className = "fail";
  });

  /* ---------- 悬浮窗开关 ---------- */
  $("panel-visible").addEventListener("change", (e) => {
    save({ qb_panel_visible: e.target.checked })
      .then(() => msg(e.target.checked ? "悬浮窗已开启" : "悬浮窗已关闭"))
      .catch((err) => msg("保存失败：" + err.message, "#c62828"));
  });

  /* ---------- 自动勾选开关 ---------- */
  $("auto-select").addEventListener("change", (e) => {
    save({ qb_auto_select: e.target.checked })
      .then(() => msg(e.target.checked ? "自动勾选已开启（逐题间隔点击）" : "自动勾选已关闭，只显示答案"))
      .catch((err) => msg("保存失败：" + err.message, "#c62828"));
  });

  /* ---------- 填空题自动填值开关 ---------- */
  if ($("auto-fill")) {
    $("auto-fill").addEventListener("change", (e) => {
      save({ qb_auto_fill_blank: e.target.checked })
        .then(() => msg(e.target.checked ? "填空题将自动填入答案" : "填空题只显示答案，不自动填写"))
        .catch((err) => msg("保存失败：" + err.message, "#c62828"));
    });
  }

  /* ---------- 自建平台的 API 基地址 ---------- */
  // 手工改过基地址就作废自动探测的缓存
  bindLiveSave("api-base", (v) => ({ qb_api_base: v.trim(), qb_api_cache: null }));

  /* ---------- 上传时是否覆盖同题干答案 ---------- */
  $("sync-overwrite").addEventListener("change", (e) => {
    save({ qb_sync_overwrite: e.target.checked })
      .then(() => msg(e.target.checked ? "上传时将用本地答案覆盖云端同题干答案" : "上传时只新增，不改动云端已有答案"))
      .catch((err) => msg("保存失败：" + err.message, "#c62828"));
  });

  /* ---------- 自定义题目选择器 ---------- */
  bindLiveSave("q-selectors", (v) => ({ qb_selectors: v.trim() }));

  /* ---------- 匹配阈值 ---------- */
  $("threshold").addEventListener("input", (e) => {
    $("threshold-val").textContent = e.target.value;
    syncThresholdFill(e.target.value);
  });
  $("threshold").addEventListener("change", (e) => {
    save({ qb_threshold: Number(e.target.value) })
      .then(() => msg("阈值已保存"))
      .catch((err) => msg("保存失败：" + err.message, "#c62828"));
  });

  /* ---------- 导出（远程 + 本地合并导出） ---------- */
  $("export").addEventListener("click", async () => {
    const data = await load();
    const merged = (data.qb_remote_questions || []).concat(data.qb_questions || []);
    const blob = new Blob([JSON.stringify(merged, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "question-bank-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    // 立刻 revoke 会让部分 Chrome 版本直接取消这次下载（存成 0 字节），留一秒再释放
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    msg("已导出 " + merged.length + " 题（远程+本地）");
  });

  /* ---------- 导入 ---------- */
  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rawList = JSON.parse(text);
      if (!Array.isArray(rawList)) {
        msg("格式错误：应为 JSON 数组", "#c62828");
        return;
      }
      const list = rawList.map(normalizeEntry).filter(Boolean); // 兼容 q/a 和 Q/A 键名
      if (!list.length) {
        msg('格式错误：未解析到有效题目，应为 [{"q":"题目","a":"答案"}, …]（键名大小写均可）', "#c62828");
        return;
      }
      const data = await load();
      // 导入同样按题干归并：已存在的题目用文件里的答案覆盖（便于批量修正错题）
      const { merged, added, updated } = mergeBanks(data.qb_questions || [], list, true);
      await save({ qb_questions: merged });
      refreshCount(await load());
      msg(`成功导入：新增 ${added.length} 题` + (updated.length ? `，修正 ${updated.length} 题` : "") +
        `，本地共 ${merged.length} 题`);
    } catch (err) {
      msg("导入失败：" + err.message, "#c62828");
    }
    e.target.value = "";
  });

  /* ---------- 清空本地题库（远程题库不受影响，重新加载即恢复） ---------- */
  $("clear").addEventListener("click", async () => {
    if (!confirm("确定清空本地添加/导入的题目？远程题库不受影响。")) return;
    try {
      await save({ qb_questions: [] });
    } catch (err) {
      msg("清空失败：" + err.message, "#c62828");
      return;
    }
    refreshCount(await load());
    msg("本地题库已清空");
  });

  // 调试钩子（供 test-popup.js 校验链接解析与云端接口拼装，不影响功能）
  window.__qbPopupDebug = {
    parseRepoRawUrl, buildRepoRawUrl, repoApi, normalizeQ, mergeBanks,
    apiCandidates, resolveRepoApi, cmpVer, normalizeUpdate, updateInfoUrl, safeHttpUrl,
    setStatus, renderUpdate, renderCachedUpdate, checkUpdate, setVerBtn, currentVersion,
  };
})();

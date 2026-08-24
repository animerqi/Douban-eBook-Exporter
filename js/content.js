let isCapturing = false;
let capturedContent = [];
let finished = false;
let baseKeyToIndex = new Map(); // 段落去重：baseKey → capturedContent 索引（支持"无图→有图"升级替换）
let seenElements = new Set(); // 元素级去重（img/svg/canvas 等独立元素）
let consecutiveEmpty = 0;
let multiPageMode = false; // 滚动式阅读器（未完结/专栏）：DOM 里有多页
let pagedMode = false; // 分页式阅读器（完结书籍）：一次一页，按键翻页
let pendingImgRounds = 0; // 分页式下等图片加载的轮数
let chapterTransition = false; // 正在跳转下一章
let transitionRounds = 0;
let transitionFailures = 0;
let lastChapterFirstKey = null; // 点击"下一篇"前，当前章节首个段落的去重键
let prevChapterUrl = null;
let chapterTitleAdded = false;
let nextChapterTitle = null; // 从"下一篇"链接解析出的下一章标题
let lastHeading = null;
let pendingImgMap = new Map(); // 待嵌入的图片：origUrl → smallUrl（兜底）
let seenImgUrls = new Set(); // 全局图片去重：同一张图（URL）整本书只输出一次
let bottomRounds = 0; // 已停在底部多少轮（多页模式章节完成的依据，有上限不会卡死）
let chapterCounter = 0; // 已抓取的章节数（用于进度显示）
let roundCounter = 0; // 轮次计数（用于周期性进度显示）
let chapterRounds = 0; // 当前章节已进行的轮数（超时兜底，防止卡死）
let captureTimer = null; // 唯一的循环定时器句柄（防止多循环并发）

const MAX_EMPTY_PAGES = 20; // 单页模式下，连续 20 轮（约 10 秒）无新内容则自动停止
const MAX_TRANSITION_ROUNDS = 40; // 章节跳转最长等待 40 轮（约 20 秒）
const CAPTURE_INTERVAL = 500; // 每轮间隔（毫秒）
const SCROLL_STEP_RATIO = 0.9; // 每轮滚动量 = 视口高度的 90%（让懒加载图片有充分时间加载）
const BOTTOM_TAIL_ROUNDS = 15; // 滚到底后最多再等 15 轮（约 7.5 秒）就进入下一章，避免永远等图片
const MAX_CHAPTER_ROUNDS = 180; // 滚动式每章最多 180 轮（约 90 秒）兜底强制进入下一章，杜绝卡死
const PAGED_INTERVAL = 800; // 分页式每轮间隔（毫秒）——比滚动式慢，给图片加载留时间
const PAGED_EMPTY_LIMIT = 45; // 分页式：连续 45 轮（约 36 秒）无新内容才判定本章结束（含恢复尝试时间）
const MAX_IMG_WAIT_ROUNDS = 10; // 分页式：等本页图片加载最多 10 轮（约 8 秒）

// 唯一的循环调度入口：防止多个 setTimeout 链并发
function scheduleCapture() {
  clearTimeout(captureTimer);
  const interval = pagedMode ? PAGED_INTERVAL : CAPTURE_INTERVAL;
  captureTimer = setTimeout(captureContent, interval);
}

// 全局错误捕获：任何异常都会显示到弹窗状态里，便于排查
window.addEventListener("error", function (e) {
  chrome.runtime
    .sendMessage({ action: "progress", text: "发生错误：" + (e.message || e) })
    .catch(function () {});
});

// ---------- 消息处理 ----------
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action === "ping") {
    sendResponse({ action: "pong" });
  } else if (message.action === "start") {
    if (!document.querySelector(".page") && !document.querySelector(".curr-page .bd .content")) {
      sendResponse({
        action: "error",
        message: "当前页面不是豆瓣阅读的阅读页，或页面结构已变化",
      });
      return;
    }
    // 手动开始：全新抓取，清掉历史进度
    resetState();
    chrome.storage.local.remove("pendingCapture");
    lastChapterFirstKey = currentFirstKey();
    prevChapterUrl = location.href;
    activateReader();
    captureContent();
    sendResponse({ action: "started" });
  } else if (message.action === "stop") {
    isCapturing = false;
    chrome.storage.local.remove("pendingCapture");
    // 直接从内容脚本发起下载，不依赖弹窗是否打开
    downloadHtml(createDownloadableHtml(capturedContent), "content.html");
    sendResponse({ action: "stopped" });
  } else if (message.action === "status") {
    // 弹窗打开时查询真实抓取状态
    sendResponse({
      action: "status",
      running: isCapturing,
      mode: pagedMode ? "paged" : multiPageMode ? "scroll" : "unknown",
      chapter: chapterCounter + 1,
      progress: progressPercent(),
      count: capturedContent.length,
      transitioning: chapterTransition,
    });
  }
});

// 回到前台时：若还在滚动抓取（未到章节底部），滚回章节顶部重新触发懒加载图片
document.addEventListener("visibilitychange", function () {
  if (
    document.visibilityState === "visible" &&
    isCapturing &&
    multiPageMode &&
    !chapterTransition &&
    !atDocumentBottom()
  ) {
    const containers = getPageContainers();
    if (containers.length > 0) {
      containers[0].scrollIntoView({ block: "start" });
    } else {
      scrollToTop();
    }
  }
});

// 注入时检查：是否正处于"整本自动抓取"中途（章节跳转可能触发整页加载）
chrome.storage.local.get(["pendingCapture"], function (res) {
  const pend = res && res.pendingCapture;
  if (
    pend &&
    pend.bookKey === currentBookKey() &&
    Array.isArray(pend.content) &&
    pend.content.length > 0
  ) {
    resetState();
    capturedContent = pend.content;
    baseKeyToIndex = new Map(pend.keys || []);
    isCapturing = true;
    lastChapterFirstKey = currentFirstKey();
    prevChapterUrl = location.href;
    scrollToTop();
    activateReader();
    captureContent();
  }
});

function resetState() {
  isCapturing = true;
  capturedContent = [];
  finished = false;
  baseKeyToIndex = new Map();
  seenElements = new Set();
  consecutiveEmpty = 0;
  multiPageMode = false;
  pagedMode = false;
  pendingImgRounds = 0;
  chapterTransition = false;
  transitionRounds = 0;
  transitionFailures = 0;
  chapterTitleAdded = false;
  nextChapterTitle = null;
  lastHeading = null;
  pendingImgMap = new Map();
  seenImgUrls = new Set();
  bottomRounds = 0;
  chapterCounter = 0;
  roundCounter = 0;
  chapterRounds = 0;
  clearTimeout(captureTimer);
  captureTimer = null;
}

// ---------- 工具 ----------
// 界面模式检测（按可靠性排序）：
// 1. URL：/reader/ebook/ → 完结书籍（分页式）；/reader/column/ → 未完结/专栏（滚动式）
// 2. DOM 兜底：内容段落带 data-pid → 分页式；多页 → 滚动式
function refreshMode() {
  const path = location.pathname;
  if (/\/reader\/ebook\//.test(path)) {
    // 完结书籍：分页式，按键翻页
    multiPageMode = false;
    pagedMode = true;
    return;
  }
  if (/\/reader\/column\//.test(path)) {
    // 未完结/专栏：滚动式，慢速滚动
    multiPageMode = true;
    pagedMode = false;
    return;
  }
  // 未知路径：DOM 特征兜底（只查内容段落，避免误匹配到 UI 元素）
  const hasPid = !!document.querySelector(
    ".page .content p[data-pid], .curr-page .bd .content p[data-pid], .curr-page p[data-pid]"
  );
  if (hasPid) {
    multiPageMode = false;
    pagedMode = true;
    return;
  }
  const pageCount = document.querySelectorAll(".page").length;
  if (pageCount >= 2) {
    multiPageMode = true;
    pagedMode = false;
  } else {
    multiPageMode = false;
    pagedMode = true;
  }
}

// 分页式下：当前页（.curr-page）是否有还没拿到 URL 的图片（有则多等几轮再翻页）
function pageHasPendingImages() {
  const cur =
    document.querySelector(".curr-page .bd .content") ||
    document.querySelector(".curr-page .content") ||
    document.querySelector(".curr-page");
  if (!cur) return false;
  const imgs = cur.querySelectorAll("img");
  for (const img of imgs) {
    if (imgUrlOf(img).length === 0) return true;
  }
  return false;
}
function currentBookKey() {
  // /reader/column/8055005/chapter/48285638/ → "column/8055005"
  // /reader/ebook/12345/ → "ebook/12345"
  const m = location.pathname.match(/\/reader\/(column\/\d+|ebook\/\d+)/);
  return m ? m[1] : location.pathname;
}

// 阅读器需要先"激活"（点击阅读区域）才会响应键盘翻页
function activateReader() {
  const candidates = [".curr-page", ".bd", ".content", "body"];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) {
      ["pointerdown", "mousedown", "mouseup", "click"].forEach(function (type) {
        el.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
        );
      });
      break;
    }
  }
}

function nextPage() {
  const opts = {
    key: "ArrowRight",
    keyCode: 39,
    which: 39,
    code: "ArrowRight",
    bubbles: true,
    cancelable: true,
  };

  document.dispatchEvent(new KeyboardEvent("keydown", opts));
  document.dispatchEvent(new KeyboardEvent("keyup", opts));
}

// 尝试点击页面上的"下一页"按钮（有些阅读器点按钮翻页，比按键更可靠）
function clickNextPageButton() {
  const sels = [
    "button[class*='next-page']",
    "button[class*='nextPage']",
    "a[class*='next-page']",
    ".reader-next",
    ".next-btn",
    "[class*='next-btn']",
    "[data-action*='next']",
    "[class*='arrow'][class*='right']",
    "button[class*='next']",
  ];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      const cls = String(el.className || "");
      if (cls.includes("disabled") || cls.includes("chapter-next")) continue;
      el.click();
      return true;
    }
  }
  return false;
}

// 找到实际滚动的容器（阅读器可能是内层滚动容器）
function getScrollRoot() {
  const pages = document.querySelectorAll(".page");
  if (pages.length) {
    let el = pages[pages.length - 1].parentElement;
    while (el && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
  }
  return document.scrollingElement || document.documentElement;
}

// 慢速滚动：每轮滚 90% 视口高度，让每一页都经过视口、懒加载图片有时间加载
function scrollStep() {
  const root = getScrollRoot();
  const step = Math.max(root.clientHeight * SCROLL_STEP_RATIO, 200);
  const remaining = root.scrollHeight - root.scrollTop - root.clientHeight;
  if (remaining > 1) {
    const before = root.scrollTop;
    root.scrollTop += Math.min(step, remaining);
    // 主滚动容器没生效时，退回 window 滚动
    if (root.scrollTop === before) {
      window.scrollBy(0, Math.min(step, remaining));
    }
  }
}

function scrollToTop() {
  const root = getScrollRoot();
  root.scrollTop = 0;
  const win = document.scrollingElement || document.documentElement;
  if (win !== root) win.scrollTop = 0;
  window.scrollTo(0, 0);
}

// 实际滚动位置百分比：容器和窗口谁在滚动用谁（避免选错滚动容器导致一直 0%）
function progressPercent() {
  const root = getScrollRoot();
  const win = document.scrollingElement || document.documentElement;
  const p1 = root.scrollHeight > 0 ? root.scrollTop / root.scrollHeight : 0;
  const p2 = win.scrollHeight > 0 ? win.scrollTop / win.scrollHeight : 0;
  return Math.round(Math.max(p1, p2) * 100);
}

// 是否已到底部：容器或窗口任一到底都算到底（修复"滚到底不翻页"）
function atDocumentBottom() {
  const root = getScrollRoot();
  const win = document.scrollingElement || document.documentElement;
  return (
    root.scrollTop + root.clientHeight >= root.scrollHeight - 50 ||
    win.scrollTop + win.clientHeight >= win.scrollHeight - 50
  );
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 内容去重键：段落文本 + 第一个逐字 span 的 data-offset；无文本段落用 innerHTML
function paragraphKey(p) {
  const text = (p.textContent || "").trim();
  if (!text) {
    return "HTML:" + (p.innerHTML || "");
  }
  const firstWord = p.querySelector("span.word");
  const offset = firstWord ? firstWord.getAttribute("data-offset") : "";
  return text + "|" + offset;
}

// 收集所有页的内容容器：
// 滚动式阅读器（专栏/连载）：整个章节多页都在 DOM 里 → .page 里的 .content
// 分页式阅读器（旧版电子书）：只有当前页 → .curr-page .bd .content
function getPageContainers() {
  const containers = [];
  const pages = document.querySelectorAll(".page");
  if (pages.length > 0) {
    pages.forEach(function (page) {
      const content =
        page.querySelector(".bd .content") ||
        page.querySelector(".content") ||
        page;
      containers.push(content);
    });
  } else {
    const cur = document.querySelector(".curr-page .bd .content");
    if (cur) containers.push(cur);
  }
  return containers;
}

// 当前章节第一个段落的去重键（用于检测章节是否已切换）
function currentFirstKey() {
  const containers = getPageContainers();
  if (!containers.length) return null;
  const firstP = containers[0].querySelector("p");
  return firstP ? paragraphKey(firstP) : null;
}

// ---------- 章节标题 ----------
function findChapterTitle() {
  const sels = [
    ".chapter-title",
    ".reader-title",
    ".chapter-name",
    ".reader-chapter-title",
    "[class*='chapter-title']",
    "h1",
  ];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el && el.textContent && el.textContent.trim()) {
      return el.textContent.trim();
    }
  }
  return null;
}

// ---------- 下一章 ----------
function isUsableChapterLink(el) {
  const cls =
    (el.className && el.className.baseVal !== undefined
      ? el.className.baseVal
      : el.className) || "";
  if (String(cls).includes("disabled")) return false;
  const text = (el.textContent || "").trim();
  if (!text) return false;
  if (
    text.includes("最后一") ||
    text.includes("已是最后一") ||
    text.includes("已经是最后一")
  ) {
    return false;
  }
  return true;
}

function findNextChapterLink() {
  const precise = document.querySelectorAll('a.chapter-next, a[class*="chapter-next"]');
  for (const el of precise) {
    if (isUsableChapterLink(el)) return el;
  }
  const generic = document.querySelectorAll('a[class*="next"]');
  for (const el of generic) {
    if (isUsableChapterLink(el)) return el;
  }
  return null;
}

// 保存抓取进度到 storage：页面意外刷新/误触跳转时，可从这里恢复继续抓
function saveProgress() {
  chrome.storage.local
    .set({
      pendingCapture: {
        bookKey: currentBookKey(),
        content: capturedContent,
        keys: Array.from(baseKeyToIndex.entries()),
      },
    })
    .catch(function () {});
}

function tryNextChapter() {
  const next = findNextChapterLink();
  if (!next) return false;
  // 从"下一篇：11-2 共同和弦转调"解析下一章的标题
  const text = (next.textContent || "").trim();
  const m = text.match(/^(?:下一篇|下一章|next)\s*[:：]?\s*(.+)$/i);
  nextChapterTitle = m ? m[1].trim() : text;
  // 保存进度：章节跳转可能是整页加载，新页面靠 storage 恢复继续抓
  saveProgress();
  next.click();
  return true;
}

function chapterChanged() {
  if (location.href !== prevChapterUrl) return true;
  const key = currentFirstKey();
  return key !== null && key !== lastChapterFirstKey;
}

// ---------- 图片下载（嵌入为 data URI，离线可读）----------
function fetchImage(url) {
  return fetch(url, { credentials: "include" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.blob();
    })
    .then(function (blob) {
      return new Promise(function (resolve) {
        const reader = new FileReader();
        reader.onload = function () {
          resolve(reader.result);
        };
        reader.onerror = function () {
          resolve(null);
        };
        reader.readAsDataURL(blob);
      });
    })
    .catch(function () {
      return null;
    });
}

function downloadImages(map, onProgress) {
  const entries = Array.from(map.entries());
  const result = {};
  let done = 0;
  let index = 0;
  const total = entries.length;
  const CONCURRENCY = 5;

  return new Promise(function (resolve) {
    if (total === 0) {
      onProgress(0, 0);
      resolve(result);
      return;
    }
    function worker() {
      if (index >= total) return;
      const entry = entries[index++];
      const orig = entry[0];
      const small = entry[1];
      // 优先大图，失败则用缩略图兜底
      fetchImage(orig).then(function (dataUri) {
        if (!dataUri && small && small !== orig) {
          return fetchImage(small);
        }
        return dataUri;
      }).then(function (dataUri) {
        if (dataUri) result[orig] = dataUri;
        done++;
        onProgress(done, total);
        worker();
      });
    }
    for (let i = 0; i < Math.min(CONCURRENCY, total); i++) {
      worker();
    }
    const timer = setInterval(function () {
      if (done >= total) {
        clearInterval(timer);
        resolve(result);
      }
    }, 200);
  });
}

// ---------- 内容转换 ----------
function imgUrlOf(imgEl) {
  return (
    (imgEl.getAttribute("data-orig-src") || "") ||
    (imgEl.getAttribute("data-src") || "") ||
    (imgEl.getAttribute("src") || "")
  );
}

function convertParagraph(paragraph) {
  const baseKey = paragraphKey(paragraph);
  const imgEl = paragraph.querySelector("img");
  const newImgUrl = imgEl ? imgUrlOf(imgEl) : "";

  try {
    const newParagraph = document.createElement("p");
    paragraph.classList.forEach(function (className) {
      newParagraph.classList.add(className);
    });

    paragraph.childNodes.forEach(function (node) {
      if (node.nodeName === "DFN") {
        node.childNodes.forEach(function (childNode) {
          if (childNode.nodeName === "SPAN") {
            newParagraph.innerHTML += childNode.innerHTML;
          } else if (childNode.nodeName === "EM") {
            newParagraph.innerHTML += "<em>" + escapeHtml(childNode.textContent) + "</em>";
          } else if (childNode.nodeName === "I") {
            newParagraph.innerHTML += "<i>" + escapeHtml(childNode.textContent) + "</i>";
          } else if (childNode.nodeName === "WBR") {
            // 忽略换行标记
          } else if (childNode.nodeName === "SUP") {
            newParagraph.innerHTML +=
              "<sup>" + escapeHtml(childNode.textContent) + "</sup>";
          } else if (childNode.nodeName === "SUB") {
            newParagraph.innerHTML +=
              "<sub>" + escapeHtml(childNode.textContent) + "</sub>";
          } else {
            console.warn(
              "Failed to convert" + childNode.nodeName + ":" + childNode.textContent
            );
          }
        });
      } else if (node.nodeName === "CODE") {
        newParagraph.innerHTML +=
          "<pre><code>" + escapeHtml(node.textContent) + "</code></pre>";
      } else if (node.nodeName === "IMG") {
        // 图片：优先高清原图；src 先用缩略图，下载完成后会替换为内嵌 data URI
        const imgOrig =
          node.getAttribute("data-orig-src") ||
          node.getAttribute("data-src") ||
          node.getAttribute("src") ||
          "";
        const imgSmall = node.getAttribute("data-src") || imgOrig;
        // 全局去重：豆瓣阅读有时会在同一段落里渲染多份相同图片，只输出第一份
        if (imgOrig && !seenImgUrls.has(imgOrig)) {
          seenImgUrls.add(imgOrig);
          pendingImgMap.set(imgOrig, imgSmall);
          newParagraph.innerHTML +=
            '<img data-orig-src="' +
            escapeHtml(imgOrig) +
            '" src="' +
            escapeHtml(imgSmall) +
            '">';
        }
      } else if (node.nodeName === "SVG") {
        // 兜底：有些书的谱例/插图用 SVG 渲染
        newParagraph.innerHTML += node.outerHTML;
      } else if (node.nodeName === "CANVAS") {
        try {
          const dataUri = node.toDataURL("image/png");
          newParagraph.innerHTML += '<img src="' + dataUri + '">';
        } catch (e) {
          console.warn("Canvas export failed:", e);
        }
      } else if (node.nodeName === "SPAN" && node.classList.contains("word")) {
        // 豆瓣阅读的逐字防复制 span，拆掉只留文字
        newParagraph.innerHTML += escapeHtml(node.textContent);
      } else if (node.nodeName === "SPAN") {
        newParagraph.innerHTML += node.innerHTML;
      } else if (node.nodeName === "#text") {
        // 忽略段落间空白文本节点
      } else if (
        node.nodeName === "DIV" &&
        node.textContent &&
        node.textContent.includes("全文完")
      ) {
        finished = true;
      } else {
        console.warn(
          "Failed to convert" + node.nodeName + ":" + node.textContent
        );
      }
    });

    // 全局图片去重 + 清理（关键）：
    // 1) 豆瓣阅读会在同一段落/嵌套 span 里渲染多份相同图片，innerHTML 复制路径会绕过逐 img 去重；
    // 2) 懒加载中的图片带有 style="opacity: 0.0X" 占位样式，不剥掉的话导出后几乎不可见。
    newParagraph.querySelectorAll("img").forEach(function (im) {
      im.removeAttribute("style"); // 去掉懒加载占位样式（opacity 等），确保图片可见
      const u = imgUrlOf(im);
      if (u) {
        if (seenImgUrls.has(u)) {
          im.remove(); // 该图已在其它地方输出过 → 删除重复份
        } else {
          seenImgUrls.add(u);
        }
      }
    });

    // 判断是否有真实内容（文字、带 URL 的图、SVG）
    let hasContent = !!newParagraph.textContent.trim();
    if (!hasContent) {
      const imgs = newParagraph.querySelectorAll("img");
      for (const im of imgs) {
        if (imgUrlOf(im).length > 0) {
          hasContent = true;
          break;
        }
      }
    }
    if (!hasContent && newParagraph.querySelector("svg")) {
      hasContent = true;
    }
    if (!hasContent) return false;

    if (baseKeyToIndex.has(baseKey)) {
      // 已抓过：如果新版有真实图片 URL、旧版没有，且该图未被其它段落输出过 → 升级替换
      const idx = baseKeyToIndex.get(baseKey);
      const old = capturedContent[idx];
      const oldImg = old.querySelector("img");
      const oldHasUrl = oldImg ? imgUrlOf(oldImg).length > 0 : false;
      if (newImgUrl && !seenImgUrls.has(newImgUrl) && !oldHasUrl) {
        capturedContent[idx] = newParagraph;
        baseKeyToIndex.set(baseKey, idx);
        return true;
      }
      return false;
    }

    capturedContent.push(newParagraph);
    baseKeyToIndex.set(baseKey, capturedContent.length - 1);
    return true;
  } catch (e) {
    console.warn("processContent error:", e);
    return false;
  }
}

function convertImageElement(imgEl) {
  const orig = imgUrlOf(imgEl);
  if (!orig) return false;
  if (seenImgUrls.has(orig)) return false; // 同一张图只输出一次
  seenImgUrls.add(orig);
  const small = imgEl.getAttribute("data-src") || orig;
  const key = "IMG:" + orig;
  if (seenElements.has(key)) return false;
  seenElements.add(key);
  pendingImgMap.set(orig, small);
  const wrapper = document.createElement("p");
  wrapper.className = "illus";
  wrapper.innerHTML =
    '<img data-orig-src="' + escapeHtml(orig) + '" src="' + escapeHtml(small) + '">';
  capturedContent.push(wrapper);
  return true;
}

function convertSvgElement(svg) {
  const key = "SVG:" + (svg.outerHTML || "");
  if (seenElements.has(key)) return false;
  seenElements.add(key);
  capturedContent.push(svg.cloneNode(true));
  return true;
}

function convertCanvasElement(canvas) {
  try {
    const dataUri = canvas.toDataURL("image/png");
    const key = "CANVAS:" + dataUri;
    if (seenElements.has(key)) return false;
    seenElements.add(key);
    const wrapper = document.createElement("p");
    wrapper.className = "illus";
    wrapper.innerHTML = '<img src="' + dataUri + '">';
    capturedContent.push(wrapper);
    return true;
  } catch (e) {
    console.warn("Canvas export failed:", e);
    return false;
  }
}

// 递归处理内容容器里的元素：P / IMG / SVG / CANVAS / 其它容器（检测全文完并继续递归）
function processElement(el) {
  const tag = el.tagName;
  if (tag === "P") return convertParagraph(el);
  if (tag === "IMG") return convertImageElement(el);
  if (tag === "SVG") return convertSvgElement(el);
  if (tag === "CANVAS") return convertCanvasElement(el);
  // 其它容器
  if (el.textContent && el.textContent.includes("全文完")) {
    finished = true;
  }
  let added = false;
  [...el.children].forEach(function (child) {
    if (processElement(child)) added = true;
  });
  return added;
}

function processContent() {
  const containers = getPageContainers();
  if (!containers.length) return 0;

  let added = 0;

  // 每个章节开头插入章节标题：优先用"下一篇"链接解析出的标题（真实章节名）
  if (!chapterTitleAdded) {
    const t = nextChapterTitle || findChapterTitle();
    if (t && t !== lastHeading) {
      const h = document.createElement("h1");
      h.textContent = t;
      capturedContent.push(h);
      lastHeading = t;
      added++;
    }
    chapterTitleAdded = true;
  }

  containers.forEach(function (container) {
    [...container.children].forEach(function (el) {
      if (processElement(el)) added++;
    });
  });

  return added;
}

// ---------- 主循环 ----------
// 下载：优先发给后台 Service Worker；失败时退回页面内 <a download> 方式下载
function downloadHtml(htmlString, filename) {
  filename = filename || "content.html";
  chrome.runtime
    .sendMessage({ action: "download", html: htmlString, filename: filename })
    .catch(function () {
      // Worker 不可用时，用 <a download> 兜底（内容脚本可用的标准下载方式）
      try {
        const blob = new Blob([htmlString], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          a.remove();
          URL.revokeObjectURL(url);
        }, 1000);
      } catch (e) {
        console.warn("download failed:", e);
      }
    });
}

function finishAndDeliver(reason) {
  isCapturing = false;
  chrome.storage.local.remove("pendingCapture");
  reason = reason || "抓取完成";

  // 合并转换时记录的图片 + 从最终内容里再收集一遍（防遗漏）
  const finalMap = new Map(pendingImgMap);
  capturedContent.forEach(function (el) {
    if (el && el.querySelectorAll) {
      el.querySelectorAll("img").forEach(function (img) {
        const orig = img.getAttribute("data-orig-src") || "";
        if (orig && !finalMap.has(orig)) {
          finalMap.set(orig, img.getAttribute("data-src") || orig);
        }
      });
    }
  });

  // 下载图片并内嵌为 data URI（离线也能完整显示）
  chrome.runtime.sendMessage({
    action: "progress",
    text: "正在下载图片 0/" + finalMap.size + "…",
  }).catch(function () {});
  downloadImages(finalMap, function (done, total) {
    chrome.runtime.sendMessage({
      action: "progress",
      text: "正在下载图片 " + done + "/" + total + "…",
    }).catch(function () {});
  }).then(function (dataUriMap) {
    capturedContent.forEach(function (el) {
      if (el && el.querySelectorAll) {
        el.querySelectorAll("img").forEach(function (img) {
          const orig = img.getAttribute("data-orig-src") || "";
          if (orig && dataUriMap[orig]) {
            img.setAttribute("src", dataUriMap[orig]);
          }
        });
      }
    });
    // 直接从内容脚本下载，不依赖弹窗是否打开（后台也能自动保存）
    downloadHtml(createDownloadableHtml(capturedContent), "content.html");
    chrome.runtime.sendMessage({
      action: "completed",
      text: "完成（" + reason + "）！已保存到下载目录",
    }).catch(function () {});
  });
}

function captureContent() {
  if (!isCapturing) return;

  try {
    refreshMode(); // 每轮重新检测界面模式（滚动式：未完结/专栏；分页式：完结书籍）

    // 章节切换中：轮询等待新章节加载完成
    if (chapterTransition) {
      transitionRounds++;
      if (chapterChanged() || transitionRounds >= MAX_TRANSITION_ROUNDS) {
        if (chapterChanged()) {
          transitionFailures = 0;
        } else {
          transitionFailures++;
          // 连续两次跳转无变化 → 说明翻到最后一章或跳转失败，结束
          if (transitionFailures >= 2) {
            finishAndDeliver("连续两次章节跳转无变化（可能是最后一章）");
            return;
          }
        }
        chapterTransition = false;
        finished = false;
        chapterTitleAdded = false;
        consecutiveEmpty = 0;
        multiPageMode = false;
        pagedMode = false;
        pendingImgRounds = 0;
        bottomRounds = 0;
        chapterRounds = 0;
        chapterCounter++;
        lastChapterFirstKey = currentFirstKey();
        prevChapterUrl = location.href;
        scrollToTop();
      }
      scheduleCapture();
      return;
    }

    const added = processContent();
    // 有新增内容立即清零空转计数（等图片期间也一样）
    if (added > 0) {
      consecutiveEmpty = 0;
    }

    // 周期性向弹窗报告进度（弹窗关着也不影响抓取）
    roundCounter++;
    chapterRounds++;
    // 每 40 轮存一次进度：误触跳转/刷新页面时最多丢失一小段内容
    if (roundCounter % 40 === 0) {
      saveProgress();
    }
    if (roundCounter % 10 === 0) {
      let text;
      if (pagedMode) {
        text =
          "正在抓取…第 " +
          (chapterCounter + 1) +
          " 章，已抓 " +
          capturedContent.length +
          " 段";
      } else {
        text =
          "正在抓取…第 " +
          (chapterCounter + 1) +
          " 章，已滚动 " +
          progressPercent() +
          "%";
      }
      chrome.runtime
        .sendMessage({ action: "progress", text: text })
        .catch(function () {});
    }

    // 分页式：等本页图片加载期间不翻页、不计空转（否则图片多的书会耗尽空转预算被误停）
    if (pagedMode && pageHasPendingImages() && pendingImgRounds < MAX_IMG_WAIT_ROUNDS) {
      pendingImgRounds++;
      scheduleCapture();
      return;
    }
    pendingImgRounds = 0;

    // 只有真正翻页后没新内容才累计空转
    if (added === 0) {
      consecutiveEmpty++;
    }

    // 滚动式：统计停留在底部的轮数（有上限，不会因图片一直加载而卡死）
    if (multiPageMode) {
      if (atDocumentBottom()) {
        bottomRounds++;
      } else {
        bottomRounds = 0;
      }
    }

    // 停止条件：
    // - 检测到「全文完」
    // - 滚动式：已滚到底部且停留 BOTTOM_TAIL_ROUNDS 轮，或章节超时兜底
    // - 分页式：连续 PAGED_EMPTY_LIMIT 轮没有新内容（翻到章节末尾）
    let stop;
    if (pagedMode) {
      stop = finished || consecutiveEmpty >= PAGED_EMPTY_LIMIT;
    } else {
      stop =
        finished ||
        (multiPageMode && bottomRounds >= BOTTOM_TAIL_ROUNDS) ||
        chapterRounds >= MAX_CHAPTER_ROUNDS;
    }

    if (stop) {
      // 记录停止原因，方便排查
      let reason;
      if (finished) {
        reason = "检测到「全文完」";
      } else if (pagedMode) {
        reason = "长时间没有新内容（可能已到本章末尾）";
      } else if (chapterRounds >= MAX_CHAPTER_ROUNDS) {
        reason = "本章抓取超时";
      } else {
        reason = "章节已滚动到底部";
      }
      // 本章抓完 → 自动跳转到下一章继续抓（整本书）
      if (tryNextChapter()) {
        chapterTransition = true;
        transitionRounds = 0;
        scheduleCapture();
        return;
      }
      // 没有下一章了 → 结束
      finishAndDeliver(reason);
      return;
    }

    // 每隔几轮没新内容就重新"激活"一次阅读区域（防焦点丢失）
    if (consecutiveEmpty > 0 && consecutiveEmpty % 5 === 0) {
      activateReader();
    }

    if (multiPageMode) {
      scrollStep(); // 滚动式：慢速滚动，让每页的懒加载图片有时间加载
      nextPage(); // 同时尝试按键翻页（对滚动式无害，兼容少量分页式渲染的界面）
    } else if (pagedMode) {
      // 连续多轮没新内容：翻页可能卡住了，尝试各种恢复手段
      if (consecutiveEmpty >= 8) {
        activateReader();
        clickNextPageButton();
      }
      nextPage(); // 分页式：模拟 → 键翻页
    }
  } catch (err) {
    // 任何异常都不允许杀死抓取循环：报错并继续
    console.warn("captureContent error:", err);
    chrome.runtime
      .sendMessage({ action: "progress", text: "抓取异常：" + (err && err.message ? err.message : err) })
      .catch(function () {});
  }
  scheduleCapture();
}

// ---------- 输出 ----------
function createDownloadableHtml(contentArray) {
  const body = contentArray
    .map(function (element) {
      return element.outerHTML;
    })
    .join("\n");
  return (
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    "<title>Douban eBook Export</title>\n" +
    "<style>\n" +
    "body { font-family: Georgia, 'Songti SC', serif; line-height: 1.9; max-width: 42em; margin: 2em auto; padding: 0 1em; }\n" +
    "p { margin: 1em 0; }\n" +
    "p.indent { text-indent: 2em; }\n" +
    "h1 { margin-top: 2em; }\n" +
    "img { max-width: 100%; height: auto; }\n" +
    "</style>\n</head>\n<body>\n" +
    body +
    "\n</body>\n</html>"
  );
}

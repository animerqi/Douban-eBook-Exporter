// 后台 Service Worker：负责下载抓取结果
//
// 重要：MV3 的 Service Worker 里【没有】URL.createObjectURL 和 Blob 相关的对象 URL API，
// 所以 blob URL 必须由内容脚本（页面上下文）创建后传进来，这里只负责调用 chrome.downloads。
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.action === "download") {
    const url = message.url || "";
    const dataUrl = message.dataUrl || "";
    const target = url || dataUrl;
    if (!target) {
      // 没有可下载的地址：让内容脚本走 <a download> 兜底
      sendResponse({ action: "download-failed", reason: "no-url" });
      return false;
    }
    chrome.downloads.download(
      {
        url: target,
        filename: message.filename || "content.html",
        saveAs: false,
      },
      function (downloadId) {
        if (chrome.runtime.lastError || downloadId === undefined) {
          sendResponse({
            action: "download-failed",
            reason: chrome.runtime.lastError
              ? chrome.runtime.lastError.message
              : "unknown",
          });
        } else {
          sendResponse({ action: "downloaded", id: downloadId });
        }
      }
    );
    return true; // 异步 sendResponse
  }
  return false;
});
